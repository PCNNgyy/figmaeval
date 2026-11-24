

def assert_assigned_file(name, arguments, assigned_file_key):
    if not assigned_file_key or name == "whoami":
        return
    if name not in {"get_metadata", "use_figma", "get_screenshot"}:
        raise ValueError("This benchmark session only permits tools for the assigned copy")
    if not isinstance(arguments, dict) or arguments.get("fileKey") != assigned_file_key:
        raise ValueError("This benchmark session cannot access original templates or other models' copies; use the assigned fileKey")
