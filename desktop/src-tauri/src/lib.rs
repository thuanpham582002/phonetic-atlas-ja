use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

#[cfg(target_os = "macos")]
mod mac_overlay {
    use cocoa::appkit::{NSScreen, NSWindow, NSWindowCollectionBehavior};
    use cocoa::base::{id, nil, YES};
    use cocoa::foundation::{NSAutoreleasePool, NSPoint, NSRect, NSSize, NSString};
    use objc::declare::ClassDecl;
    use objc::runtime::{Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Once;

    // Tauri's alwaysOnTop maps to NSFloatingWindowLevel (3), which gets pushed
    // under fullscreen apps and after Space/display changes. ScreenSaver level
    // (1000) keeps the strip pinned across all those transitions — same trick
    // SketchyBar uses.
    const NS_SCREEN_SAVER_WINDOW_LEVEL: i64 = 1000;
    const COLLAPSED_WIDTH: f64 = 44.0;
    static COLLAPSED: AtomicBool = AtomicBool::new(false);

    /// Re-pin the overlay to the bottom of the current `mainScreen` visibleFrame.
    /// Safe to call repeatedly (used both at setup and on screen-change events).
    pub unsafe fn pin_to_main_screen(ns_win: id) {
        let screen: id = NSScreen::mainScreen(nil);
        if screen == nil {
            return;
        }
        let visible: NSRect = NSScreen::visibleFrame(screen);
        let win_frame: NSRect = NSWindow::frame(ns_win);
        let height = win_frame.size.height;
        let width = if COLLAPSED.load(Ordering::Relaxed) {
            COLLAPSED_WIDTH
        } else {
            visible.size.width
        };
        // Cocoa origin is bottom-left, Y grows upward, so visible.origin.y is
        // the bottom edge of the usable screen area (above the Dock).
        let new_frame = NSRect::new(
            NSPoint::new(visible.origin.x, visible.origin.y),
            NSSize::new(width, height),
        );
        NSWindow::setFrame_display_(ns_win, new_frame, YES);
    }

    pub unsafe fn set_collapsed(ns_win: id, collapsed: bool) {
        COLLAPSED.store(collapsed, Ordering::Relaxed);
        pin_to_main_screen(ns_win);
    }

    pub unsafe fn configure_overlay_window(ns_win: id) {
        NSWindow::setCollectionBehavior_(
            ns_win,
            NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
        );
        NSWindow::setLevel_(ns_win, NS_SCREEN_SAVER_WINDOW_LEVEL);
        pin_to_main_screen(ns_win);
    }

    extern "C" fn handle_screen_change(this: &Object, _: Sel, _notification: id) {
        unsafe {
            let ns_win_ptr: *mut Object = *this.get_ivar("ns_win");
            if ns_win_ptr.is_null() {
                return;
            }
            // Screen geometry may have shifted (monitor plugged/unplugged,
            // resolution change, notch-display swap). Re-apply level too in
            // case AppKit dropped us back to floating during the transition.
            let ns_win = ns_win_ptr as id;
            NSWindow::setLevel_(ns_win, NS_SCREEN_SAVER_WINDOW_LEVEL);
            pin_to_main_screen(ns_win);
        }
    }

    static REGISTER_OBSERVER_CLASS: Once = Once::new();

    /// Subscribe to `NSApplicationDidChangeScreenParametersNotification` so the
    /// overlay re-pins itself whenever displays are added/removed/resized.
    /// The observer object is leaked deliberately — it lives for the app's
    /// lifetime, same as the overlay window itself.
    pub unsafe fn install_screen_change_observer(ns_win: id) {
        REGISTER_OBSERVER_CLASS.call_once(|| {
            let superclass = class!(NSObject);
            let mut decl = ClassDecl::new("PAOverlayScreenObserver", superclass)
                .expect("PAOverlayScreenObserver already registered");
            decl.add_ivar::<*mut Object>("ns_win");
            decl.add_method(
                sel!(screenChanged:),
                handle_screen_change as extern "C" fn(&Object, Sel, id),
            );
            decl.register();
        });

        let cls = objc::runtime::Class::get("PAOverlayScreenObserver")
            .expect("PAOverlayScreenObserver class missing");
        let observer: id = msg_send![cls, new];
        (*observer).set_ivar("ns_win", ns_win as *mut Object);

        let pool = NSAutoreleasePool::new(nil);
        let name =
            NSString::alloc(nil).init_str("NSApplicationDidChangeScreenParametersNotification");
        let center: id = msg_send![class!(NSNotificationCenter), defaultCenter];
        let _: () = msg_send![center,
            addObserver: observer
            selector: sel!(screenChanged:)
            name: name
            object: nil];
        let _: () = msg_send![pool, drain];
    }
}

// Holds the spawned FastAPI/uvicorn sidecar so we can kill it on quit.
struct Sidecar(Mutex<Option<Child>>);

/// Toggle the overlay's keyboard focus from anywhere. If it isn't focused,
/// activate + focus it; if it already is, deactivate the app so focus returns
/// to whatever app was underneath. With the accessory activation policy,
/// `set_focus()` alone doesn't route key events to the window — the app must
/// also be activated, so we call `activateIgnoringOtherApps:` on macOS.
fn toggle_overlay_focus(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let focused = win.is_focused().unwrap_or(false);
        #[cfg(target_os = "macos")]
        unsafe {
            use cocoa::appkit::NSApplication;
            use cocoa::base::{nil, YES};
            use objc::{msg_send, sel, sel_impl};
            let ns_app = NSApplication::sharedApplication(nil);
            if focused {
                // Resign active status — focus returns to the previous app while
                // the overlay stays visible (screen-saver level + all-Spaces).
                let _: () = msg_send![ns_app, deactivate];
                return;
            }
            let _: () = msg_send![ns_app, activateIgnoringOtherApps: YES];
        }
        #[cfg(not(target_os = "macos"))]
        if focused {
            return;
        }
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn set_opacity(window: WebviewWindow, value: f64) -> Result<(), String> {
    // Tauri 2 exposes window.set_opacity via the cocoa shim on macOS.
    // We clamp to a sane range to avoid an invisible window the user can't grab.
    let v = value.clamp(0.15, 1.0);
    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSWindow;
        use cocoa::base::id;
        let ns_win = window.ns_window().map_err(|e| e.to_string())? as id;
        unsafe { NSWindow::setAlphaValue_(ns_win, v) };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, v);
    }
    Ok(())
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_collapsed(window: WebviewWindow, collapsed: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use cocoa::base::id;
        let ns_win = window.ns_window().map_err(|e| e.to_string())? as id;
        unsafe { mac_overlay::set_collapsed(ns_win, collapsed) };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, collapsed);
    }
    Ok(())
}

/// Try to spawn the PyInstaller-bundled server binary shipped inside the .app.
/// Falls back to `.venv/bin/python -m uvicorn` for development.
fn spawn_backend(app_dir: std::path::PathBuf) -> Option<Child> {
    // 1) Bundled binary — shipped inside .app at Resources/binaries/
    if let Ok(exe) = std::env::current_exe() {
        let res = exe.parent().and_then(|p| p.parent()).map(|p| p.join("Resources/binaries"));
        if let Some(bin_dir) = res {
            // Try with target-triple suffix (Tauri externalBin), then bare name
            for name in &["server-bundle-aarch64-apple-darwin", "server-bundle"] {
                let path = bin_dir.join(name);
                if path.exists() {
                    eprintln!(
                        "[phonetic-atlas-overlay] spawning bundled server {}",
                        path.display()
                    );
                    let child = Command::new(&path)
                        .args(["--root", &app_dir.to_string_lossy(), "--port", "7842"])
                        .current_dir(&app_dir)
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .ok()?;
                    eprintln!(
                        "[phonetic-atlas-overlay] spawned bundled server-bundle (pid {})",
                        child.id()
                    );
                    return Some(child);
                }
            }
        }
    }

    // 2) Dev fallback: use repo .venv
    let venv_py = app_dir.join(".venv/bin/python");
    if venv_py.exists() {
        eprintln!(
            "[phonetic-atlas-overlay] spawning dev backend via {}",
            venv_py.display()
        );
        let child = Command::new(&venv_py)
            .args([
                "-m",
                "uvicorn",
                "server:app",
                "--host",
                "127.0.0.1",
                "--port",
                "7842",
            ])
            .current_dir(&app_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        eprintln!(
            "[phonetic-atlas-overlay] spawned dev backend (pid {})",
            child.id()
        );
        return Some(child);
    }

    eprintln!(
        "[phonetic-atlas-overlay] WARN: no bundled server or .venv found; assuming backend already runs on :7842"
    );
    None
}

fn repo_root_from_exe() -> std::path::PathBuf {
    // dev: target/debug/phonetic-atlas-overlay  → 4 parents = repo root
    // bundled: <app>.app/Contents/MacOS/<bin>   → fall back to repo checkout or env var
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().skip(1) {
            if ancestor.join("server.py").exists() && ancestor.join(".venv").exists() {
                return ancestor.to_path_buf();
            }
        }
    }
    // Check well-known repo checkout path (dev machine)
    if let Some(home) = std::env::var_os("HOME") {
        let dev = std::path::PathBuf::from(home).join("self-project/phonetic-atlas");
        if dev.join("server.py").exists() && dev.join(".venv").exists() {
            return dev;
        }
    }
    // Allow override via env var
    if let Ok(repo) = std::env::var("PHONETIC_ATLAS_REPO") {
        let repo = std::path::PathBuf::from(repo);
        if repo.join("server.py").exists() {
            return repo;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_dir = repo_root_from_exe();
    let child = spawn_backend(app_dir.clone());

    // Global hotkey ⌘⌥Space — focus the overlay from any app so its keyboard
    // shortcuts (Space, ←→, d, l, …) work without first clicking the strip.
    let focus_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::Space);

    tauri::Builder::default()
        .manage(Sidecar(Mutex::new(child)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut(focus_shortcut)
                .expect("failed to register focus shortcut")
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &focus_shortcut && event.state() == ShortcutState::Pressed {
                        toggle_overlay_focus(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            set_opacity,
            set_always_on_top,
            set_collapsed
        ])
        .setup(|app| {
            let overlay_url = tauri::Url::parse("http://127.0.0.1:7842/?view=overlay")
                .map_err(|e| e.to_string())?;
            for _ in 0..30 {
                if std::net::TcpStream::connect("127.0.0.1:7842").is_ok() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            // Hide from Cmd+Tab + Dock: behave as a macOS "accessory" app
            // (same activation policy as menu-bar utilities like SketchyBar).
            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{NSApplication, NSApplicationActivationPolicy};
                unsafe {
                    let ns_app = NSApplication::sharedApplication(cocoa::base::nil);
                    NSApplication::setActivationPolicy_(
                        ns_app,
                        NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory,
                    );
                }
            }
            if let Some(win) = app.get_webview_window("overlay") {
                let _ = win.navigate(overlay_url);
                let _ = win.show();
                #[cfg(debug_assertions)]
                win.open_devtools();
                if std::env::var("PHONETIC_ATLAS_OVERLAY_DEVTOOLS").is_ok() {
                    win.open_devtools();
                }
                // Always-on-top + float over fullscreen
                let _ = win.set_always_on_top(true);
                #[cfg(target_os = "macos")]
                {
                    use cocoa::base::id;
                    if let Ok(ns_win) = win.ns_window() {
                        let ns_win = ns_win as id;
                        unsafe {
                            mac_overlay::configure_overlay_window(ns_win);
                            mac_overlay::install_screen_change_observer(ns_win);
                        }
                    }
                }
                let _ = win;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Sidecar>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
