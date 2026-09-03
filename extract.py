import json

log_path = "/Users/abhishek/.gemini/antigravity/brain/eca64f1e-8400-4abe-b4fb-1d190eb1d67d/.system_generated/logs/transcript_full.jsonl"
with open(log_path, 'r') as f:
    for line in f:
        data = json.loads(line)
        if data.get('type') == 'USER_INPUT':
            content = data.get('content', '')
            if '{"format":"backtesting_dataset"' in content:
                start = content.find('{"format":"backtesting_dataset"')
                json_str = content[start:]
                # Try to clean trailing tags like </USER_REQUEST> if they exist
                end = json_str.rfind(']}')
                if end != -1:
                    json_str = json_str[:end+2]
                with open('/Users/abhishek/.gemini/antigravity/brain/eca64f1e-8400-4abe-b4fb-1d190eb1d67d/scratch/data.json', 'w') as out:
                    out.write(json_str)
                print("Extracted successfully!")
                break
