"""Only produce an application image; Launcher owns boot/partition management."""
Import("env")
from SCons.Errors import UserError
from SCons.Script import COMMAND_LINE_TARGETS

if any(t in COMMAND_LINE_TARGETS for t in ("upload", "uploadfs", "erase")):
    raise UserError("Use M5Launcher's SD-card app installer with firmware.bin; direct flashing is disabled.")
