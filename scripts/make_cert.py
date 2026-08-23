#!/usr/bin/env python3
"""生成 openk 用的自签 HTTPS 证书。

为什么卡拉OK 需要 https：浏览器只在「安全上下文」下开放 getUserMedia，
也就是 https 或 localhost。用手机、平板连局域网里的 openk 时地址是
http://192.168.x.x:8000，属于不安全来源，navigator.mediaDevices 干脆不存在，
点「开始录唱」只会得到一句「当前浏览器不支持麦克风」——其实浏览器支持得很好。

用法：
    python -m scripts.make_cert                       # 自动探测本机地址
    python -m scripts.make_cert 192.168.1.10 nas.local

生成 data/certs/openk.crt 与 openk.key，然后：
    export OPENK_SSL_CERTFILE=data/certs/openk.crt
    export OPENK_SSL_KEYFILE=data/certs/openk.key

首次访问浏览器会警告证书不受信任（自签证书本来就这样），点进去继续即可；
接受之后该来源就是安全上下文，麦克风随之可用。iOS 需要在
设置 ▸ 通用 ▸ VPN与设备管理 里安装描述文件，再到 关于本机 ▸ 证书信任设置 打开信任。
"""
from __future__ import annotations

import datetime
import ipaddress
import socket
import sys
from pathlib import Path

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
except ImportError:
    sys.exit("缺少依赖：pip install cryptography")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend import config  # noqa: E402


def local_ips() -> list[str]:
    """尽力探测本机在局域网里的地址。"""
    found = {"127.0.0.1"}
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # 不会真的发包，只为让内核选出出口地址
        found.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except socket.gaierror:
        pass
    return sorted(found)


def build_san(names: list[str]) -> tuple[list[x509.GeneralName], list[str]]:
    entries: list[x509.GeneralName] = []
    shown: list[str] = []
    seen: set[str] = set()
    for raw in names:
        name = raw.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        try:
            entries.append(x509.IPAddress(ipaddress.ip_address(name)))
        except ValueError:
            entries.append(x509.DNSName(name))
        shown.append(name)
    return entries, shown


def main() -> int:
    names = sys.argv[1:] or [*local_ips(), "localhost", socket.gethostname()]
    san, shown = build_san(names)
    if not san:
        return print("没有可用的主机名/IP") or 1

    out = config.DATA_DIR / "certs"
    out.mkdir(parents=True, exist_ok=True)
    crt, key = out / "openk.crt", out / "openk.key"

    pkey = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "openk")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(pkey.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))  # 浏览器接受的上限
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(pkey, hashes.SHA256())
    )

    crt.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key.write_bytes(pkey.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    key.chmod(0o600)

    print("证书已生成：")
    print(f"  {crt}")
    print(f"  {key}")
    print("覆盖的地址：" + "、".join(shown))
    print("\n启用：")
    print(f"  export OPENK_SSL_CERTFILE={crt}")
    print(f"  export OPENK_SSL_KEYFILE={key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
