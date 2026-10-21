"""Download public OKX sample evidence only; never connects to account APIs/databases."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
import threading
import time
import urllib.request
import urllib.parse
import subprocess

M = 60_000
DAY = 86_400_000
INSTRUMENTS = ("BTC-USDT-SWAP", "ETH-USDT-SWAP")
UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
_gate = threading.Lock()
_last = 0.0

def fetch(url):
    global _last
    for attempt in range(6):
        with _gate:
            pause = max(0, _last + .16 - time.monotonic())
            if pause: time.sleep(pause)
            _last = time.monotonic()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
                data = r.read()
            return data
        except Exception:
            if attempt == 5: raise
            time.sleep(min(8, 2 ** attempt))

def digest(data): return hashlib.sha256(data).hexdigest()
def now(): return datetime.now(timezone.utc).isoformat()
def pack(path, obj):
    data = gzip.compress(json.dumps(obj, separators=(",", ":")).encode(), mtime=0)
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_bytes(data)
    temporary.replace(path)
    return digest(data)

def candles(job, folder):
    path = folder / (job["key"] + ".json.gz")
    if path.exists():
        cached = json.loads(gzip.decompress(path.read_bytes()))
        if cached.get("job") != job: raise ValueError(f"Cache identity mismatch: {path}")
        for page in cached["pages"]:
            if digest(page["responseText"].encode()) != page["responseSHA256"]: raise ValueError(f"Corrupt cached response: {path}")
        return {**job, "file": path.name, "sha256": digest(path.read_bytes()), "pages": len(cached["pages"])}
    cursor, pages = job["endExclusive"], []
    while cursor > job["start"]:
        params = {"instId": job["instrumentId"], "bar": job["bar"], "after": str(cursor), "limit": str(job["limit"])}
        url = "https://www.okx.com/api/v5/market/" + job["endpoint"] + "?" + urllib.parse.urlencode(params)
        for attempt in range(6):
            raw = fetch(url)
            data = json.loads(raw)
            if data.get("code") == "0": break
            if data.get("code") != "50011" or attempt == 5: raise ValueError(f"OKX error {data.get('code')}: {data.get('msg')}")
            time.sleep(min(8, 2 ** attempt))
        rows = data.get("data", [])
        if not rows: raise ValueError(f"Empty historical page: {url}")
        timestamps = [int(row[0]) for row in rows]
        if max(timestamps) >= cursor or min(timestamps) >= cursor: raise ValueError(f"Pagination did not advance: {url}")
        pages.append({"url": url, "fetchedAtUTC": now(), "responseSHA256": digest(raw), "responseText": raw.decode()})
        cursor = min(timestamps)
    sha = pack(path, {"job": job, "pages": pages})
    return {**job, "file": path.name, "sha256": sha, "pages": len(pages)}

def funding(day, folder):
    date = day.strftime("%Y-%m-%d")
    name = "funding-" + date + ".zip"
    path = folder / name
    meta = path.with_suffix(".source.json")
    if path.exists() and meta.exists():
        info = json.loads(meta.read_text())
        if info["sha256"] != digest(path.read_bytes()): raise ValueError(f"Corrupt funding cache: {path}")
        return info
    url = f"https://static.okx.com/cdn/okex/traderecords/swaprates/daily/{day:%Y%m%d}/allswap-fundingrates-{date}.zip?v=1001"
    raw = fetch(url)
    if not raw.startswith(b"PK"): raise ValueError(f"Expected ZIP: {url}")
    info = {"kind": "fundingArchive", "date": date, "url": url, "fetchedAtUTC": now(), "sha256": digest(raw), "file": name}
    path.write_bytes(raw)
    meta.write_text(json.dumps(info, indent=2) + "\n")
    return info

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("storage/crypto-samples/okx-20240101-v1/raw"))
    args = parser.parse_args()
    if subprocess.check_output(["git", "branch", "--show-current"], text=True).strip() != "codex/okx-crypto-training":
        raise SystemExit("Use the authorized crypto branch")
    args.output.mkdir(parents=True, exist_ok=True)
    replay = datetime.fromisoformat("2024-01-01T00:00:00+08:00")
    start = replay - timedelta(days=90)
    end = replay + timedelta(hours=72)
    end_exclusive = end + timedelta(minutes=1)
    ms = lambda d: int(d.timestamp() * 1000)
    jobs = []
    for instrument in INSTRUMENTS:
        for kind, endpoint, limit in [("last", "history-candles", 300), ("mark", "history-mark-price-candles", 100)]:
            day = start
            while day < end_exclusive:
                stop = min(day + timedelta(days=1), end_exclusive)
                jobs.append({"key": f"{instrument}-{kind}-1m-{day:%Y%m%d}", "kind": kind, "instrumentId": instrument,
                             "bar": "1m", "intervalMs": M, "start": ms(day), "endExclusive": ms(stop), "endpoint": endpoint, "limit": limit})
                day = stop
            for bar, interval in [("1H", 60 * M), ("1D", DAY)]:
                jobs.append({"key": f"{instrument}-{kind}-{bar}-crosscheck", "kind": kind, "instrumentId": instrument,
                             "bar": bar, "intervalMs": interval, "start": ms(start), "endExclusive": ms(end), "endpoint": endpoint, "limit": limit})
    days = []
    day = start - timedelta(days=1)
    while day.date() <= end.date():
        days.append(day)
        day += timedelta(days=1)
    entries = []
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=8) as pool:
        work = [pool.submit(candles, job, args.output) for job in jobs] + [pool.submit(funding, day, args.output) for day in days]
        for future in as_completed(work):
            entries.append(future.result())
            if len(entries) % 20 == 0 or len(entries) == len(work):
                print(json.dumps({"completedFiles": len(entries), "totalFiles": len(work), "seconds": round(time.monotonic() - started)}), flush=True)
    manifest = {"downloadVersion": "okx-p2-download-v1", "fetchedAtUTC": now(), "exchange": "OKX", "timezone": "Asia/Shanghai",
                "backgroundStart": ms(start), "replayStart": ms(replay), "replayEnd": ms(end), "executionEndExclusive": ms(end_exclusive),
                "instruments": list(INSTRUMENTS), "entries": sorted(entries, key=lambda x: x["file"])}
    target = args.output / "download-index.json"
    target.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"status": "downloaded", "index": str(target), "files": len(entries)}), flush=True)

if __name__ == "__main__": main()
