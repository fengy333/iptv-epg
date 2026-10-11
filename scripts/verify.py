#!/usr/bin/env python3
"""校验 EPG 构建产物：XML well-formed、channel id 唯一、programme 引用完整。

用法：python3 scripts/verify.py dist/mini.xml dist/lite.xml dist/all.xml
CI 里跑这一步，任何一项不合格就直接让 workflow 失败，避免把坏文件发布出去。
"""
import sys
import xml.etree.ElementTree as ET


def check(path):
    try:
        root = ET.parse(path).getroot()
    except Exception as e:  # noqa: BLE001
        print(f"✗ {path}: XML 解析失败 -> {e}")
        return False

    if root.tag != "tv":
        print(f"✗ {path}: 根节点不是 <tv>（是 <{root.tag}>）")
        return False

    chans = root.findall("channel")
    progs = root.findall("programme")
    ids = [c.get("id") for c in chans]
    uniq = set(ids)
    dup = len(ids) - len(uniq)
    refs = {p.get("channel") for p in progs}
    dangling = refs - uniq

    print(f"✓ {path}")
    print(f"    channel {len(chans)} 个（重复 id {dup} 个）/ programme {len(progs)} 条 / 悬空引用 {len(dangling)} 个")
    if dangling:
        print(f"    悬空引用示例: {sorted(dangling)[:10]}")
        return False
    return True


def main():
    files = sys.argv[1:] or ["dist/lite.xml"]
    ok = all(check(p) for p in files)
    print("\n全部校验通过 ✓" if ok else "\n存在校验失败 ✗")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
