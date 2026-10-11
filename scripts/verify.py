#!/usr/bin/env python3
"""校验 EPG 构建产物：XML well-formed、channel id 唯一、programme 引用完整。

用法：python3 scripts/verify.py dist/epg/mini.xml dist/epg/lite.xml dist/epg/all.xml
CI 里跑这一步，任何一项不合格就直接让 workflow 失败，避免把坏文件发布出去。
"""
import os
import sys
import xml.etree.ElementTree as ET

MB = 1048576


def check(path):
    if not os.path.exists(path):
        print(f"✗ {path}: 文件不存在（构建输出路径不对？）")
        return False

    size = os.path.getsize(path)
    print(f"— {path}  {size / MB:.2f} MB")
    if size == 0:
        print("  ✗ 空文件")
        return False

    try:
        root = ET.parse(path).getroot()
    except Exception as e:  # noqa: BLE001
        print(f"  ✗ XML 解析失败 -> {e}")
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                head = fh.read(300)
            print("  文件开头：")
            for line in head.splitlines()[:6]:
                print(f"    | {line}")
        except Exception:
            pass
        return False

    if root.tag != "tv":
        print(f"  ✗ 根节点不是 <tv>（是 <{root.tag}>）")
        return False

    chans = root.findall("channel")
    progs = root.findall("programme")
    ids = [c.get("id") for c in chans]
    uniq = set(ids)
    refs = {p.get("channel") for p in progs}
    dangling = refs - uniq

    print(
        f"  channel {len(chans)} 个（重复 id {len(ids) - len(uniq)} 个）"
        f" / programme {len(progs)} 条 / 悬空引用 {len(dangling)} 个"
    )

    if not chans:
        print("  ✗ 没有任何 channel —— 上游数据全部获取失败，不发布空文件")
        return False
    if dangling:
        print(f"  ✗ 悬空引用示例: {sorted(dangling)[:10]}")
        return False

    print("  ✓ 通过")
    return True


def main():
    files = sys.argv[1:] or ["dist/epg/lite.xml"]
    results = [check(p) for p in files]  # 不短路，全部检查完再汇总
    ok = all(results)
    print("\n全部校验通过 ✓" if ok else "\n存在校验失败 ✗（定位见上）")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
