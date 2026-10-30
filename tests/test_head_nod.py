import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class HeadNod(unittest.TestCase):
    def test_nod_motion_and_servo_packets(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = str(Path(temporary) / "head_nod_test")
            subprocess.run(["c++", "-std=c++11", "-I", str(ROOT / "src"),
                            str(ROOT / "tests/head_nod_test.cpp"), "-o", binary], check=True)
            subprocess.run([binary], check=True)


if __name__ == "__main__":
    unittest.main()
