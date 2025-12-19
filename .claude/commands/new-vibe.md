# Create a New Vibe

Create a new self-contained HTML vibe (tool/applet) for v.tlab.sh.

## Workflow

1. **Get vibe details** from user:
   - Name (kebab-case, e.g., `color-picker`)
   - Description (one sentence)
   - Core functionality

2. **Create a branch**:
   - `git checkout -b <vibe-name>`

3. **Create the vibe**:
   - Create directory: `<vibe-name>/`
   - Create `<vibe-name>/index.html` following the template in CLAUDE.md
   - Keep it under 300 lines (if possible)
   - Create a `<vibe-name>/README.md` describing the vibe and including an `## Initial prompt` section with the prompt used to create the vibe

4. **Update README.md**:
   - Add entry under `## Vibes` section:
     ```markdown
     - [Vibe Name](vibe-name/) - brief description
     ```

5. **Test locally** (if possible):
   - `npx serve -p 8080 --cors --no-clipboard &` (run in background)
   - Open: `http://localhost:8080/<vibe-name>/`

6. **Open PR**:
   - Push branch and create PR to `main`
   - Include deployment link: `https://v.tlab.sh/<vibe-name>/`
   - PRs are squash merged

## Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{VIBE_NAME}}</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
            background: #fafafa;
        }
        h1 { margin-bottom: 0.5rem; }
        .description { color: #666; margin-top: 0; }
        .card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin: 20px 0;
        }
        input, textarea, select {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 6px;
            font-size: 16px;
            margin-bottom: 10px;
        }
        input:focus, textarea:focus, select:focus {
            outline: none;
            border-color: #007bff;
        }
        button {
            background: #007bff;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            font-size: 14px;
            cursor: pointer;
        }
        button:hover { background: #0056b3; }
        .output { display: none; }
        .output.visible { display: block; }
        @media (max-width: 600px) {
            body { padding: 15px; }
        }
    </style>
</head>
<body>
    <h1>{{VIBE_NAME}}</h1>
    <p class="description">{{DESCRIPTION}}</p>

    <div class="card">
        <!-- Input UI -->
    </div>

    <div id="output" class="output card">
        <!-- Output UI -->
        <button id="copy">Copy</button>
    </div>

    <script>
        // Real-time processing
        document.getElementById('input').addEventListener('input', (e) => {
            const value = e.target.value.trim();
            if (value) {
                // Process and show output
                document.getElementById('output').classList.add('visible');
            } else {
                document.getElementById('output').classList.remove('visible');
            }
        });

        // Copy to clipboard
        document.getElementById('copy').addEventListener('click', () => {
            const text = document.getElementById('result').textContent;
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('copy');
                btn.textContent = 'Copied!';
                setTimeout(() => btn.textContent = 'Copy', 1500);
            });
        });

        // URL state (optional)
        const hash = decodeURIComponent(location.hash.slice(1));
        if (hash) {
            document.getElementById('input').value = hash;
            document.getElementById('input').dispatchEvent(new Event('input'));
        }
    </script>
</body>
</html>
```

## Checklist

- [ ] Branch created from `main`
- [ ] Directory created at `<vibe-name>/`
- [ ] `<vibe-name>/README.md` created with description and initial prompt
- [ ] `index.html` created with all inline CSS/JS
- [ ] Mobile responsive (test at 375px width)
- [ ] 16px minimum font for inputs
- [ ] Copy button with feedback
- [ ] README.md updated with link
- [ ] No external dependencies (or CDN only)
- [ ] Under 300 lines
- [ ] PR opened to `main`
