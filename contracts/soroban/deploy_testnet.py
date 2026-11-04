"""Testnet deployment with exact input parsing and a fail-closed operation journal."""
import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"


def address(value):
    try:
        raw = base64.b32decode(value)
        valid = len(raw) == 35 and raw[0] == 48 and raw[-2:] == binascii.crc_hqx(raw[:-2], 0).to_bytes(2, "little")
    except (ValueError, binascii.Error):
        valid = False
    if not valid:
        raise argparse.ArgumentTypeError("expected a checksummed Stellar G address")
    return value


def atomic(value):
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,7})?", value) or len(value) > 48:
        raise argparse.ArgumentTypeError("amount must be a positive decimal with at most 7 places")
    whole, _, frac = value.partition(".")
    amount = int(whole) * 10**7 + int(frac.ljust(7, "0"))
    if not 0 < amount <= 2**127 - 1:
        raise argparse.ArgumentTypeError("amount outside positive i128 range")
    return amount


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--operator", type=address)
    parser.add_argument("--owner", type=address)
    parser.add_argument("--max", type=atomic, default=atomic("100"))
    parser.add_argument("--daily", type=atomic, default=atomic("1000"))
    parser.add_argument("--only", choices=("accounts", "vault"))
    parser.add_argument("--manifest", type=Path, default=Path("deploy-testnet-manifest.json"))
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.source):
        parser.error("source must be a local CLI identity name")
    if args.only != "accounts" and not args.operator:
        parser.error("--operator is required for vault deployment")
    if args.max > args.daily:
        parser.error("--max must not exceed --daily")
    if not shutil.which("stellar"):
        parser.error("stellar CLI is required")
    # Local identity lookup; no contract build or network operation.
    source_address = address(subprocess.check_output(["stellar", "keys", "address", args.source], text=True).strip())
    owner = args.owner or source_address
    journal = {"network": "testnet", "source": source_address, "owner": owner,
               "operator": args.operator, "maxAtomic": str(args.max), "dailyAtomic": str(args.daily),
               "only": args.only, "steps": {}, "artifacts": {}}
    manifest = args.manifest.resolve()
    # Exclusive creation protects concurrent operators; any existing journal needs reconciliation.
    with manifest.open("x") as f:
        json.dump(journal, f, indent=2)
        f.flush()
        os.fsync(f.fileno())

    def save():
        fd, name = tempfile.mkstemp(dir=manifest.parent, prefix=manifest.name + ".")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(journal, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, manifest)
            directory = os.open(manifest.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def run(step, argv):
        journal["steps"][step] = {"state": "UNKNOWN", "command": argv}
        save()  # Persist intent before invoking a CLI that might lose its response.
        result = subprocess.check_output(["stellar", *argv], text=True).strip()
        if step == "account_upload":
            valid_result = bool(re.fullmatch(r"[0-9a-fA-F]{64}", result))
        else:
            try:
                raw = base64.b32decode(result)
                valid_result = len(raw) == 35 and raw[0] == 16 and raw[-2:] == binascii.crc_hqx(raw[:-2], 0).to_bytes(2, "little")
            except (ValueError, binascii.Error):
                valid_result = False
        if not valid_result:
            raise RuntimeError("invalid CLI response; reconcile the UNKNOWN step before another deployment")
        journal["steps"][step] = {"state": "COMPLETED", "result": result, "command": argv}
        save()
        return result

    subprocess.run(["stellar", "contract", "build"], check=True, stdout=sys.stderr)
    wasm = Path("target/wasm32v1-none/release")
    names = (["tilcai_account", "tilcai_ed25519_verifier", "tilcai_webauthn_verifier", "tilcai_account_factory"] if args.only != "vault" else [])
    if args.only != "accounts":
        names.append("tilcai_vault")
    for name in names:
        journal["artifacts"][name] = hashlib.sha256((wasm / (name + ".wasm")).read_bytes()).hexdigest()
    save()
    net = ["--network", "testnet", "--source-account", args.source]

    def deploy(step, name, params=()):
        return run(step, ["contract", "deploy", *net, "--wasm", str(wasm / (name + ".wasm")), *params])

    if args.only != "vault":
        account = run("account_upload", ["contract", "upload", *net, "--wasm", str(wasm / "tilcai_account.wasm")])
        ed = deploy("ed25519", "tilcai_ed25519_verifier")
        web = deploy("webauthn", "tilcai_webauthn_verifier")
        factory = deploy("factory", "tilcai_account_factory", ["--", "--account_wasm_hash", account, "--ed25519_verifier", ed, "--webauthn_verifier", web])
        print("ACCOUNT_FACTORY_STELLAR=" + factory)
    if args.only != "accounts":
        vault = deploy("vault", "tilcai_vault", ["--", "--usdc", USDC, "--owner", owner, "--operator", args.operator,
                        "--max_per_disbursement", str(args.max), "--daily_limit", str(args.daily)])
        print("VAULT_STELLAR=" + vault)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError, argparse.ArgumentTypeError, RuntimeError) as exc:
        print(f"Deployment stopped: {exc}. Preserve the manifest; reconcile before retrying.", file=sys.stderr)
        sys.exit(1)
