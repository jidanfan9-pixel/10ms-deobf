import os
import signal
import subprocess
import sys
import time


def main():
    restart_delay = int(os.getenv("BOT_RESTART_DELAY", "5"))
    while True:
        print("[launcher] starting discord_bot.py", flush=True)
        process = subprocess.Popen([sys.executable, "discord_bot.py"])
        code = process.wait()
        if os.getenv("BOT_NO_RESTART", "0") == "1":
            return code
        print(f"[launcher] bot exited with code {code}; restarting in {restart_delay}s", flush=True)
        time.sleep(restart_delay)


if __name__ == "__main__":
    raise SystemExit(main())
