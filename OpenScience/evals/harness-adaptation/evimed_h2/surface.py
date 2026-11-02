"""The editable surface of the platform's DSH runtime, as Harness2 sees it.

Always on: `guidance.md` only, at most 4,000 characters (every session pays for it on every turn). On demand: `skills/<name>/SKILL.md`.
Absent by design (docs: design section 14): plugins (`plugin_dir=None`), command hooks (`hooks_file=None`), sub-agent definitions,
guardrail / memory / tool-description files, and anything that is code the kernel would load. The base tree is one empty
`guidance.md`; the platform's own current rules ride along as a read-only stub, which `read_tree` never returns, so an editor can
read them and cannot change them.

Upstream's prompt module only knows its own two substrates. `register_prompts()` adds the 'dsh' texts to its registry (a private
dict, pinned by test) instead of patching the file.
"""

from __future__ import annotations

from . import config, upstream

SURFACE_NAME = "dsh"
GUIDANCE = "guidance.md"

SKILLS_STUB = (
    "<!-- skills: reusable procedures loaded on demand. Add one as skills/<name>/SKILL.md with frontmatter `name:` equal to the "
    "directory and a `description:`. Name it in guidance.md in the same edit. -->\n"
)

_SURFACE_BODY = """\
You may write ONLY these paths. Anything else is off the editable surface: it is dropped before your work is used, however good it is.

| path | component | when it is in context |
|---|---|---|
| `guidance.md` | a short supplement to the platform's standing guidance | ALWAYS ON for this task: every token is paid on every turn. Hard cap 4,000 characters |
| `skills/<name>/SKILL.md` | a reusable procedure | loaded ON DEMAND, only when the agent loads it with its `skill` tool |

`reference/current-guidance.md` is the platform's own standing guidance, READ-ONLY context. `guidance.md` ADDS to it. Do not repeat
what it says, do not contradict it, and do not copy it across: a supplement that restates it only spends characters.

NOT ON THIS SURFACE: scripts, sub-agents, plugins, hooks, memory files, tool descriptions, guardrail files. Nothing that runs code in
the tool loop exists here. Ignore every mention of them elsewhere in this brief.

The three rules that discard the whole proposal. Validation runs before any rollout:

1. EVERY SKILL NEEDS A TRIGGER LINE. If you create or keep `skills/<name>/SKILL.md`, its directory name must appear VERBATIM in
   `guidance.md`, in the SAME edit: `When <the situation this skill handles>, load the `<name>` skill.` Frontmatter needs
   `name:` equal to the directory and a `description:`, or the skill is dropped silently at load.
2. ALWAYS-ON TEXT IS CAPPED at 4,000 characters in total (the trigger lines count). A supplement that needs more belongs in a skill.
3. THIS IS PROCESS TEXT, NOT TASK TEXT. A harness is checked before it is rolled: it is refused if it contains a long stretch of any
   task's wording, more than a handful of numerals, or the name of a data set, file, trial, paper or person that a task mentions.
   Say HOW to work (what to check, in what order, when to stop, what to hand back), never WHAT the answer is, and never quote.

How a run uses it. `guidance.md` is placed, whole, in front of the task. All the skills of a harness reach the agent as sections of
ONE skill that it loads when the situation matches, so write each skill to stand alone and make its `description:` say when to load it.

Change only what a trajectory shows needs changing. Always-on prose is the expensive option: put anything with a recognisable trigger
in a skill, and keep `guidance.md` to a few short rules that hold for essentially every task of this kind. If the evidence does not
argue for a change, leave everything as it is and say KEEP_BASE in your notes.

THE ANSWER'S SHAPE BELONGS TO THE REQUEST, NOT TO YOU. A harness changes HOW the agent works; it must never change WHAT SHAPE it
delivers. Where the task names a final line, a format, an order or a language, that is part of what was asked for. Guidance that makes the
agent's reasoning visible belongs in the working, never in the delivered answer, unless the task asks for it.
"""

SURFACE_TTS = "# EDITABLE HARNESS SURFACE\n\n" + _SURFACE_BODY
SURFACE_ADAPT = "# WHAT YOU CAN CHANGE\n\n" + _SURFACE_BODY + """
# HOW TO MAKE A CHANGE

The harness is in `context/harness/`, and it is YOURS TO EDIT. Open the files, change them in place with your normal tools, and create new
ones where a new component is the right lever. Your edits on disk ARE the proposal; nothing you write in this reply changes the harness.
Files you do not touch are inherited unchanged. Delete a file to remove that component. Then reply with ONE `<notes>` block and nothing
else: for each change, the moment in a trajectory that motivated it.
"""


def _guidance_reference() -> str:
    try:
        return config.GUIDANCE_SNAPSHOT.read_text(encoding="utf-8")
    except OSError as exc:  # a missing snapshot would silently hand the editors no context at all
        raise RuntimeError(f"guidance snapshot missing ({config.GUIDANCE_SNAPSHOT}): run tools/snapshot_guidance.mjs") from exc


def build_surface():
    """The SurfaceSpec. Built on demand because upstream is imported lazily."""
    up = upstream.load()
    return up.tree.SurfaceSpec(
        name=SURFACE_NAME,
        always_on=(GUIDANCE,),
        always_on_max=config.ALWAYS_ON_MAX,
        always_on_cap_reason="every session pays for this text on every turn; move anything situational into a skill",
        skill_dir="skills",
        skill_name_rule="must_match",
        trigger_hint=(
            "Fix it by adding a trigger line naming `{name}` to guidance.md, e.g. "
            '"When <the situation this skill handles>, load the `{name}` skill."'
        ),
        autotrigger_file=GUIDANCE,
        trigger_line="- When {desc}, load the `{name}` skill.\n",
        subagent_requires_mode=False,
        plugin_dir=None,
        hooks_file=None,
        stubs=(
            ("skills/README.md", SKILLS_STUB),
            ("reference/current-guidance.md", _guidance_reference()),
        ),
    )


def register_prompts() -> None:
    """Teach upstream's prompt module the 'dsh' surface. Idempotent."""
    up = upstream.load()
    prompts = up.prompts
    inv = prompts._INV_TEMPLATE.replace(
        "__LOOP_LEVER__", "standing rule in guidance.md (this surface has no tool-loop lever); keep it short and say what it must not block"
    )
    dom = prompts._DOM_TEMPLATE.replace(
        "__TRIGGER_SENTENCE__", "A skill exists only once its name appears in guidance.md: write that trigger line in the same edit."
    )
    prompts._SURFACE_TEXTS[SURFACE_NAME] = prompts._SurfaceText(
        surface_md=SURFACE_ADAPT, inv=inv, dom=dom, tts_surface=SURFACE_TTS
    )
