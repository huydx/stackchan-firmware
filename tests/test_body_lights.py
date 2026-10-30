import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class BodyLights(unittest.TestCase):
    def test_mute_red_and_speaking_rainbow(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = str(Path(temporary) / "body_lights_test")
            subprocess.run(["c++", "-std=c++11", "-I", str(ROOT / "src"),
                            str(ROOT / "tests/body_lights_test.cpp"), "-o", binary], check=True)
            subprocess.run([binary], check=True)


if __name__ == "__main__":
    unittest.main()
