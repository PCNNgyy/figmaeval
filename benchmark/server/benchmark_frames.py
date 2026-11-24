import re

SCREEN_COUNT_RULE_VERSION = 'support-board-exclusion/v3'
SUPPORT_BOARD_RE = re.compile(r'(?:^|\s*[·:|—-]\s*)(?:library|foundations?|ui[\s_-]*kit|reusable[\s_-]+(?:ui|system)|_?icon[\s_-]*store)(?:$|\s*[·:|—-])',re.I)


def benchmark_product_frame(node):
    name = str(node.get("name", ""))
    if node.get("type", "FRAME") != "FRAME" or re.search(
        r"components?|design[\s_]*system|^review\b|^reference\b|组件库|素材库", name, re.I
    ):
        return False
    if re.match(r"^\d{2}_",name):
        return True
    if SUPPORT_BOARD_RE.search(name):
        return False
    return (
        node.get("width", node.get("w", 0)) >= 300 and node.get("height", node.get("h", 0)) >= 500
    )


FIGMA_PRODUCT_FRAME_PREDICATE = (
    "const productFrame=n=>n.type==='FRAME'&&"
    "!/components?|design[\\s_]*system|^review\\b|^reference\\b|组件库|素材库/i.test(n.name)&&"
    "(/^\\d{2}_/.test(n.name)||(!/(?:^|\\s*[·:|—-]\\s*)(?:library|foundations?|ui[\\s_-]*kit|reusable[\\s_-]+(?:ui|system)|_?icon[\\s_-]*store)(?:$|\\s*[·:|—-])/i.test(n.name)&&n.width>=300&&n.height>=500));"
)
