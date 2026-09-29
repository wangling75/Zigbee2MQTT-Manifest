#!/usr/bin/env python3
"""Serve and validate the Zigbee2MQTT Z2MB v12 bundle for ESP32 gateways."""
import hmac
import json
import os
import subprocess
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

PORT = int(os.environ.get('PORT', 8088))
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT_DIR, 'public')
BUILD_IR_DIR = os.path.join(ROOT_DIR, 'build_ir')
DIST_DIR = os.path.join(ROOT_DIR, 'dist')
MANIFEST_FILE = os.path.join(PUBLIC_DIR, 'z2m_manifest.json')
BUNDLE_FILE = os.path.join(PUBLIC_DIR, 'z2m_bundle.bin')
GENERATE_TOKEN = os.environ.get('Z2M_GENERATE_TOKEN', '')
ALLOW_REBUILD = os.environ.get('ALLOW_REBUILD') == '1'

TOOLS_DIR = os.path.join(ROOT_DIR, 'tools')
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)

from validate_bundle import validate_bundle  # noqa: E402


def bundle_is_valid(path):
    """Run the canonical v12 validator against the published bundle."""
    try:
        validate_bundle(path, MANIFEST_FILE)
        return True
    except (OSError, ValueError, KeyError):
        return False


def build_binary_bundle():
    """Run the same fully gated candidate build/promote path as CI."""
    subprocess.run(
        ['python3', os.path.join(ROOT_DIR, 'tools', 'build_candidate.py'),
         '--promote'],
        cwd=ROOT_DIR, check=True,
    )
    with open(MANIFEST_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


class ManifestHTTPHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path == '/api/status':
            data = {}
            if os.path.exists(MANIFEST_FILE):
                with open(MANIFEST_FILE, 'r', encoding='utf-8') as f:
                    data = json.load(f)
            body = json.dumps({'status': 'online', 'manifest': data}, indent=2).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != '/api/generate':
            self.send_response(404)
            self.end_headers()
            return

        if not ALLOW_REBUILD:
            self.send_response(403)
            self.end_headers()
            return
        supplied = self.headers.get('Authorization', '')
        expected = f'Bearer {GENERATE_TOKEN}' if GENERATE_TOKEN else ''
        if not expected or not hmac.compare_digest(supplied, expected):
            self.send_response(401)
            self.end_headers()
            return

        try:
            manifest = build_binary_bundle()
            body = json.dumps({'success': True, 'manifest': manifest}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            body = json.dumps({'error': str(exc)}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def run_server():
    if os.environ.get('FORCE_REBUILD') == '1':
        build_binary_bundle()
    elif not bundle_is_valid(BUNDLE_FILE):
        raise SystemExit(
            'published z2m_bundle.bin failed v12 validation; '
            'set FORCE_REBUILD=1 only after reviewing the rebuild'
        )

    httpd = HTTPServer(('', PORT), ManifestHTTPHandler)
    print('==================================================')
    print(f' Z2M Binary Bundle Server is running on port {PORT}')
    print(f' Manifest URL  : http://localhost:{PORT}/z2m_manifest.json')
    print(f' Bundle URL    : http://localhost:{PORT}/z2m_bundle.bin')
    print(f' Status API    : http://localhost:{PORT}/api/status')
    print('==================================================')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
        httpd.server_close()


if __name__ == '__main__':
    run_server()
