/* Meridian Workbench — Mission Control chip in the topbar: "N agents working" / "N waiting for you".
 * The counts come from the Meridian window hosting this page (wb:command { type: 'mission' });
 * clicking asks the host to open Mission Control. No main-process privileges involved.
 */
function missionChip({ working = 0, waiting = 0, live = 0 } = {}) {
  let chip = document.getElementById('mission-chip');
  if (!chip) {
    const bar = document.getElementById('topbar');
    if (!bar) return;
    chip = document.createElement('button');
    chip.id = 'mission-chip';
    chip.className = 'chip mission-chip';
    chip.innerHTML = '<span class="mdot"></span><span class="mtext"></span>';
    chip.addEventListener('click', () => wb.toHost({ type: 'mission-open' }));
    bar.insertBefore(chip, document.getElementById('launcher'));
  }
  const n = (x) => Number.isFinite(+x) ? Math.max(0, Math.floor(+x)) : 0;
  working = n(working); waiting = n(waiting); live = n(live);
  chip.hidden = !live && !working && !waiting;
  chip.classList.toggle('busy', working > 0);
  chip.classList.toggle('waiting', waiting > 0);
  chip.querySelector('.mtext').textContent = waiting
    ? `${waiting} waiting for you${working ? ` · ${working} working` : ''}`
    : working ? `${working} agent${working === 1 ? '' : 's'} working` : `${live} agent${live === 1 ? '' : 's'} idle`;
  chip.title = 'Open Mission Control';
}
