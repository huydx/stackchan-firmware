import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PlaybackBuffers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.binary = str(Path(cls.temporary.name) / "playback_pool_test")
        subprocess.run(["c++", "-std=c++11", "-pthread", "-I", str(ROOT / "src"),
                        str(ROOT / "tests/playback_pool_test.cpp"), "-o", cls.binary], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_borrowed_pcm_is_not_reused(self):
        subprocess.run([self.binary, "borrow"], check=True)

    def test_playback_credit_preserves_frame_order(self):
        subprocess.run([self.binary, "order"], check=True)

    def test_repeated_playback_and_reset(self):
        subprocess.run([self.binary, "repeat"], check=True)
