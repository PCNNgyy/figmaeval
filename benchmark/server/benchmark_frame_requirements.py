import re


def expected_frame_count(brief):
    legacy_patterns = [
        r'build\s+exactly\s+(?:(?:the|these)\s+)?(\d+)\s+frames?',
        r'deliver\s+all\s+(\d+)\s+frames?',
        r'containing\s+the\s+(\d+)\s+named\s+frames?',
    ]
    values = {int(n) for pattern in legacy_patterns for n in re.findall(pattern, brief, re.I)}
    legacy_declared = bool(values)
    explicit = {int(n) for n in re.findall(
        r'deliver\s+(\d+)\s+named\s+editable\s+frames?', brief, re.I)}
    explicit.update(int(n) for n in re.findall(
        r'^.{0,240}[·|]\s*(\d+)\s+frames?\s*$', brief[:2000], re.I | re.M))
    values.update(explicit)
    if len(values) != 1:
        raise ValueError('Cannot deterministically extract the required frame count from the task brief')
    count = values.pop()
    if not 1 <= count <= 200:
        raise ValueError('Required frame count is outside the supported range')
    if explicit and not legacy_declared:
        scope = re.split(r'Fixed data\s*&\s*copy|Deliver in your own Figma file', brief, flags=re.I)[0]
        headings = re.findall(r'^\s*(\d{2,3}[A-Z]?_[^\n]+)$', scope, re.M)
        numbers = sorted({int(re.match(r'\d+', name).group()) for name in headings})
        contiguous = numbers and numbers[0] in (0, 1) and numbers == list(range(numbers[0], numbers[-1] + 1))
        prefixes = {name.split('_', 1)[0] for name in headings}
        if len(headings) != count or len(set(headings)) != count or len(prefixes) != count or not contiguous:
            raise ValueError('Declared frame total does not match the numbered screen checklist')
    return count
