#!/usr/bin/env python3
"""
voe.sx stream extractor
Calls the internal API to get a fresh, signed m3u8 URL
"""
import requests
import re
import json
import sys

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://voe.sx/",
    "Origin": "https://voe.sx",
}

def extract_voe(url: str) -> dict:
    """
    Extract stream URLs from voe.sx.
    Returns dict with hls, mp4, and other stream URLs.
    """
    session = requests.Session()
    session.headers.update(HEADERS)

    # Step 1: Fetch the page, follow redirects (voe.sx aliases like caseyseemavoid.com)
    r = session.get(url, timeout=15)
    r.raise_for_status()
    html = r.text
    final_url = r.url  # May redirect to caseyseemavoid.com/FILEID

    # Step 2: Extract the file ID from URL
    file_id = re.search(r'/([a-z0-9]{8,20})(?:\?|$|/)', r.url)
    if not file_id:
        file_id = re.search(r'voe\.sx/([a-z0-9]{8,20})', url)
    file_id = file_id.group(1) if file_id else None
    print(f"[*] File ID: {file_id}")
    print(f"[*] Final URL: {final_url}")

    result = {
        "file_id": file_id,
        "hls": None,
        "mp4": None,
        "sources": [],
        "raw": {}
    }

    # Step 3: Try the /e/ endpoint (voe's stream API)
    base = re.match(r'(https?://[^/]+)', final_url).group(1)
    
    api_endpoints = [
        f"{base}/e/{file_id}",         # embed endpoint
        f"https://voe.sx/e/{file_id}", # canonical
    ]

    for endpoint in api_endpoints:
        try:
            er = session.get(endpoint, timeout=10, 
                           headers={**HEADERS, "Referer": url})
            if er.status_code == 200 and len(er.text) > 100:
                embed_html = er.text
                # Extract from embed page
                hls = re.search(r'["\']?(https?://[^"\'<>\s]+\.m3u8[^"\'<>\s]*)["\']?', embed_html)
                if hls:
                    result["hls"] = hls.group(1)
                    print(f"[+] HLS from embed: {result['hls']}")
                    break
        except Exception as e:
            print(f"[-] Endpoint {endpoint} failed: {e}")

    # Step 4: Try direct API call (voe sometimes has /api/file/info)
    if not result["hls"]:
        try:
            api_r = session.get(
                f"https://voe.sx/api/file/info/{file_id}",
                headers=HEADERS,
                timeout=10
            )
            if api_r.status_code == 200:
                data = api_r.json()
                result["raw"] = data
                print("[+] API response:", json.dumps(data, indent=2)[:500])
        except Exception as e:
            print(f"[-] API failed: {e}")

    # Step 5: Parse the page for any stream config in JS vars
    # voe.sx loads streams via loader.js — check the application/json script
    json_script = re.search(r'<script type=["\']application/json["\']>(.*?)</script>', 
                            html, re.DOTALL)
    if json_script:
        print(f"[*] Found application/json script ({len(json_script.group(1))} bytes)")
        # This is voe's encoded player config — yt-dlp decodes it
        # Fallback: use yt-dlp directly

    # Step 6: Fallback — use yt-dlp subprocess
    if not result["hls"]:
        print("[*] Falling back to yt-dlp...")
        try:
            import subprocess
            proc = subprocess.run(
                ["yt-dlp", "--get-url", "--no-warnings", url],
                capture_output=True, text=True, timeout=30
            )
            if proc.returncode == 0:
                for line in proc.stdout.strip().splitlines():
                    line = line.strip()
                    if line.startswith("http"):
                        if ".m3u8" in line:
                            result["hls"] = line
                        elif ".mp4" in line:
                            result["mp4"] = line
                        result["sources"].append(line)
                print("[+] yt-dlp URLs:", result["sources"])
        except FileNotFoundError:
            print("[!] yt-dlp not installed: pip install yt-dlp")
        except Exception as e:
            print(f"[-] yt-dlp failed: {e}")

    return result


def download_stream(hls_url: str, output: str = "output.mp4"):
    """Download HLS stream using ffmpeg or yt-dlp."""
    import subprocess
    
    # Try ffmpeg first
    try:
        cmd = [
            "ffmpeg", "-y",
            "-headers", f"Referer: https://voe.sx/\r\nOrigin: https://voe.sx\r\n",
            "-i", hls_url,
            "-c", "copy",
            output
        ]
        print(f"[*] Downloading with ffmpeg -> {output}")
        subprocess.run(cmd, check=True)
        return True
    except FileNotFoundError:
        pass
    
    # Fallback to yt-dlp
    try:
        cmd = ["yt-dlp", "--referer", "https://voe.sx/", "-o", output, hls_url]
        print(f"[*] Downloading with yt-dlp -> {output}")
        subprocess.run(cmd, check=True)
        return True
    except Exception as e:
        print(f"[-] Download failed: {e}")
        return False


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "https://voe.sx/m3ev6b5kiypu"
    
    print(f"[*] Extracting: {target}")
    data = extract_voe(target)
    
    print("\n" + "="*60)
    print("RESULTS:")
    if data["hls"]:
        print(f"  HLS  : {data['hls']}")
    if data["mp4"]:
        print(f"  MP4  : {data['mp4']}")
    if data["sources"]:
        for s in data["sources"]:
            print(f"  URL  : {s}")
    
    if not any([data["hls"], data["mp4"], data["sources"]]):
        print("  [!] No streams found")
        print()
        print("  Direct yt-dlp commands to try:")
        print(f"    yt-dlp '{target}'")
        print(f"    yt-dlp --referer 'https://voe.sx/' '{target}'")
        print(f"    yt-dlp --cookies-from-browser chrome '{target}'")
    else:
        # Offer download
        best = data["hls"] or data["mp4"] or data["sources"][0]
        print()
        print("  To stream in VLC:")
        print(f"    vlc '{best}'")
        print()
        print("  To download with ffmpeg:")
        print(f"    ffmpeg -headers 'Referer: https://voe.sx/' -i '{best}' -c copy out.mp4")
        print()
        print("  To download with yt-dlp:")
        print(f"    yt-dlp --referer 'https://voe.sx/' '{best}'")
