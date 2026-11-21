"""Capacity decisions for cold restarts inside an already admitted campaign slot."""
from pathlib import Path


def process_token(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] == 'Z' else fields[19]
    except FileNotFoundError:
        return None


def can_admit(active, reserved, own, campaign_owned=False, batch_claimed=False):
    if own in active or batch_claimed:
        return False
    occupied = set(active) | set(reserved)
    return len(occupied) < 2 or (len(occupied) == 2 and campaign_owned and own in reserved)


def choose_slot(active, reservations, candidates, campaign_pid, campaign_token):
    reserved = {r['slot'] for r in reservations}
    for slot in candidates:
        held = [r for r in reservations if r['slot'] == slot]
        owned = lambda r: str(r.get('campaignPid', '')) == str(campaign_pid) and r.get('campaignToken') == campaign_token
        if can_admit(active, reserved, slot, any(owned(r) for r in held), any(not owned(r) for r in held)):
            return slot
    return None
