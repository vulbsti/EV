# Draws assets/architecture-{light,dark}.svg. Run: python3 assets/src/architecture.py
from pathlib import Path

THEMES = {
    "light": dict(bg="#ffffff", fg="#1f2328", muted="#59636e", line="#8c959f", box="#f6f8fa", stroke="#d0d7de", ev="#ddf4ff", evs="#54aeff", work="#fff8c5", works="#d4a72c", mem="#fbefff", mems="#c297ff"),
    "dark": dict(bg="#0d1117", fg="#e6edf3", muted="#9198a1", line="#6e7681", box="#161b22", stroke="#30363d", ev="#0c2d6b", evs="#4493f8", work="#3b2300", works="#bb8009", mem="#271052", mems="#ab7df8"),
}

def svg(t):
    W, H = 880, 470
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">',
         f'<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="{t["line"]}"/></marker></defs>',
         f'<rect width="{W}" height="{H}" fill="{t["bg"]}"/>']
    def box(x, y, w, h, title, lines, fill, stroke):
        o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        o.append(f'<text x="{x+16}" y="{y+28}" font-size="16" font-weight="600" fill="{t["fg"]}">{title}</text>')
        for i, l in enumerate(lines):
            o.append(f'<text x="{x+16}" y="{y+52+i*20}" font-size="13" fill="{t["muted"]}">{l}</text>')
    def arrow(x1, y1, x2, y2, label=None, lx=None, ly=None, anchor="middle"):
        o.append(f'<path d="M{x1} {y1}L{x2} {y2}" stroke="{t["line"]}" stroke-width="1.5" fill="none" marker-end="url(#a)"/>')
        if label:
            o.append(f'<text x="{lx}" y="{ly}" font-size="12" fill="{t["muted"]}" text-anchor="{anchor}">{label}</text>')

    box(20, 40, 150, 100, "You", ["say it roughly,", "in one conversation"], t["box"], t["stroke"])
    box(250, 20, 300, 160, "EV", ["reads every message with what it", "knows about you and the work", "under way, looks up anything else,", "then acts through tools: reply, ask,", "start work, tell or hold work, remember"], t["ev"], t["evs"])
    box(630, 20, 230, 160, "Work", ["OpenClaw agents, each in", "its own container and folder,", "keeping session and files", "", "reviewer opens the result and", ""], t["work"], t["works"])
    o.append(f'<text x="646" y="172" font-size="13" fill="{t["muted"]}">sends it back until it is right</text>')
    box(250, 250, 300, 100, "Learner", ["turns what happened into memory:", "said vs guessed, with evidence,", "and a dated history"], t["mem"], t["mems"])
    box(20, 250, 150, 100, "Importers", ["your Claude Code", "sessions"], t["box"], t["stroke"])
    o.append(f'<rect x="20" y="390" width="840" height="60" rx="12" fill="{t["box"]}" stroke="{t["stroke"]}" stroke-width="1.5"/>')
    o.append(f'<text x="440" y="416" font-size="15" font-weight="600" fill="{t["fg"]}" text-anchor="middle">One store on your machine</text>')
    o.append(f'<text x="440" y="436" font-size="13" fill="{t["muted"]}" text-anchor="middle">SQLite, files and one full-text index that EV, agents and the reviewer all search; forget removes from all of it</text>')

    arrow(170, 75, 248, 75, "message", 209, 68)
    arrow(248, 115, 172, 115, "reply, ask", 209, 132)
    arrow(550, 75, 628, 75, "brief", 589, 68)
    arrow(628, 125, 552, 125, "result", 589, 142)
    arrow(400, 182, 400, 248)
    o.append(f'<text x="410" y="220" font-size="12" fill="{t["muted"]}">every turn and finished work</text>')
    arrow(95, 352, 95, 388)
    arrow(400, 352, 400, 388)
    arrow(745, 182, 745, 388)
    o.append(f'<text x="755" y="290" font-size="12" fill="{t["muted"]}">results, files</text>')
    o.append('</svg>')
    return "\n".join(o) + "\n"

out = Path(__file__).resolve().parent.parent
for name, t in THEMES.items():
    (out / f"architecture-{name}.svg").write_text(svg(t))
