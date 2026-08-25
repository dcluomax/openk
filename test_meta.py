"""标题 →（歌手, 歌名）解析的回归测试。

点歌台按歌手分组、按拼音首字母检索，全靠这一层把 YouTube / 本地文件那些
五花八门的标题拆开。用例都取自真实曲库里出现过的写法。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from backend.steps.lyrics_sources import guess_meta  # noqa: E402

PASS = FAIL = 0


def check(title, artist, track, note=""):
    global PASS, FAIL
    meta = guess_meta({"title": title})
    got = (meta["artist"], meta["track"])
    if got == (artist, track):
        PASS += 1
    else:
        FAIL += 1
        print(f"  ✗ {note or title}\n      期望 {(artist, track)}\n      实际 {got}")


def main():
    # 最常见的破折号写法
    check("周杰倫 Jay Chou - 稻香", "周杰倫", "稻香", "破折号 + 罗马音歌手")
    check("五月天 - 突然好想你", "五月天", "突然好想你")

    # 书名号里的歌名最可靠
    check("周杰倫《晴天》Official MV", "周杰倫", "晴天", "书名号，歌手在前")
    check("《 跟往事乾杯》演唱  - 姜育恆", "姜育恆", "跟往事乾杯", "书名号，歌手在后")

    # KTV 碟片的编号格式
    check("NO -240 淚的小雨- 高勝美(國語) (娛己娛人卡拉OK) - 特大字幕MV",
          "高勝美", "淚的小雨", "KTV 编号碟")

    # 各种噪声后缀要被清掉，而不是被当成歌名
    check("林俊傑 JJ Lin - 江南 (Official Music Video)", "林俊傑", "江南", "官方 MV 后缀")
    check("告白氣球 KARAOKE", None, "告白氣球", "只有歌名 + 伴唱标记")

    # 罗马音和中文混排时，应当归一到中文名，否则同一位歌手会被拆成好几组
    a1 = guess_meta({"title": "Mayday五月天 - 洗衣機"})["artist"]
    a2 = guess_meta({"title": "MAYDAY五月天 - 憨人"})["artist"]
    global PASS, FAIL
    if a1 == a2 == "五月天":
        PASS += 1
    else:
        FAIL += 1
        print(f"  ✗ 罗马音归一失败：{a1!r} vs {a2!r}")

    # 没有任何分隔线索时，宁可不猜歌手，也不要把整个标题塞进 artist
    meta = guess_meta({"title": "11 mm 慢慢 张学友 344402"})
    if meta["artist"] is None or len(meta["artist"]) <= 20:
        PASS += 1
    else:
        FAIL += 1
        print(f"  ✗ 无线索时不该乱猜歌手：{meta['artist']!r}")

    # 空标题不能炸
    check("", None, None, "空标题")

    print(f"\n通过 {PASS} 项，失败 {FAIL} 项")
    return 1 if FAIL else 0


if __name__ == "__main__":
    print("== 标题解析 ==")
    sys.exit(main())
