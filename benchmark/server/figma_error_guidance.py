import re
from mcp.types import TextContent

def with_error_guidance(result):
    if not getattr(result,'isError',False):return result
    text='\n'.join(p.text for p in result.content if getattr(p,'type','')=='text');hints=[]
    if re.search(r'Reaction.*invalid|destination.*reject|prototype source',text,re.I):
        hints.append('Save the required frames in a separate successful call before setting reactions. Read their persisted IDs, and use a different top-level destination frame on the same page. Do not combine rebuilding all screens with a prototype retry.')
    if re.search(r'parent is an instance|inside of an instance|cannot be overridden in an instance',text,re.I):
        hints.append('INSTANCE children have editing restrictions. Use supported overrides or a FRAME wrapper around the reused instance instead of inserting, moving or resizing arbitrary children inside it.')
    if re.search(r'createInstance.*(?:null|TEXT)|(?:null|TEXT).*createInstance',text,re.I):
        hints.append('Resolve the current node ID and check node.type before calling createInstance; this method requires a COMPONENT, not a TEXT node or a missing node.')
    if re.search(r'font|loadFontAsync',text,re.I):
        hints.append('Use the exact font family/style available in Figma and load that pair before changing text. Query listAvailableFontsAsync if the required style is unclear; keep the font families required by the brief.')
    if re.search(r'textAlignHorizontal.*(?:invalid|LEFT)',text,re.I):
        hints.append('Figma textAlignHorizontal enum values are uppercase: LEFT, CENTER, RIGHT, JUSTIFIED.')
    if not hints:return result
    hint='Execution guidance (original tool error preserved): '+' '.join(hints)
    return result.model_copy(update={'content':[*result.content,TextContent(type='text',text=hint)]})
