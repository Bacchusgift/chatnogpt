"""Tiny SSH/SFTP helper for deploying ChatNoGPT (temp tool, safe to delete)."""
import os
import sys
import time

import paramiko

HOST = os.environ.get("SSH_HOST", "your-server.example.com")
USER = os.environ.get("SSH_USER", "root")


def _connect():
    pw = os.environ["SSH_PASS"]
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, port=22, username=USER, password=pw, timeout=15,
                banner_timeout=15, auth_timeout=15, look_for_keys=False, allow_agent=False)
    return cli


def run(cmd, timeout=120, show=True):
    """Run a shell command on the server; return (exit_code, combined_output)."""
    cli = _connect()
    try:
        _, out, err = cli.exec_command(cmd, timeout=timeout)
        buf = out.read().decode("utf-8", "replace")
        ebuf = err.read().decode("utf-8", "replace")
        code = out.channel.recv_exit_status()
        text = (buf + ebuf).strip()
        if show:
            print(f"$ {cmd}\n[code {code}]\n{text}\n")
        return code, text
    finally:
        cli.close()


def put(local_path, remote_path):
    cli = _connect()
    try:
        sftp = cli.open_sftp()
        sftp.put(local_path, remote_path)
        st = sftp.stat(remote_path)
        print(f"uploaded {local_path} -> {remote_path} ({st.st_size} bytes)")
        sftp.close()
    finally:
        cli.close()


def retry(fn, tries=3, wait=5):
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"attempt {i+1} failed: {e!r}; retry in {wait}s")
            time.sleep(wait)
    raise last


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "probe"
    if action == "run":
        code, text = run(sys.argv[2], timeout=int(sys.argv[3]) if len(sys.argv) > 3 else 120)
        sys.exit(code if code else 0)
    elif action == "put":
        put(sys.argv[2], sys.argv[3])
