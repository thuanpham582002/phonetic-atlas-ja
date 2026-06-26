import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aligner import Aligner
from scripts.process_samples import process_sample, sample_dirs


def main():
    parser = argparse.ArgumentParser(description="Regenerate v2 sample words.json files.")
    parser.add_argument("samples", nargs="*", help="sample slugs; defaults to all samples")
    args = parser.parse_args()

    aligner = Aligner()
    for sample_dir in sample_dirs(args.samples):
        try:
            print(process_sample(aligner, sample_dir, force=True))
        except Exception as e:
            print(f"{sample_dir.name:24} ERROR {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
