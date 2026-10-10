import { execSync } from 'child_process';

try {
  const psCmd = 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name = \'node.exe\'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"';
  const output = execSync(psCmd, { encoding: 'utf8' });
  const procs = JSON.parse(output);
  for (const p of (Array.isArray(procs) ? procs : [procs])) {
    console.log(`[PID ${p.ProcessId}] ${p.CommandLine}`);
  }
} catch (e) {
  console.error(e.message);
}
