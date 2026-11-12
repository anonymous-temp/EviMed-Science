import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function cleanupResources(inventory) {
  const { context, name, label, postgres, network, egress, volume, pgVolume, imageTag } = inventory;
  if (!/^vcrbench-[a-z0-9][a-z0-9-]{3,33}$/.test(name)
      || !label?.startsWith('org.evimed.benchmark.owner='+name+':')
      || !/^[a-f0-9]{24}$/.test(label.split(':').at(-1))
      || postgres !== name+'-pg' || network !== name+'-internal' || egress !== name+'-egress'
      || volume !== name+'-data' || pgVolume !== name+'-pgdata' || imageTag !== name+':runtime') {
    throw new Error('Unrecognized benchmark resource inventory');
  }
  const docker = (...args) => execFileSync('docker', ['--context', context, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 60_000,
  }).trim();
  const list = (type, ...extra) => docker(type, 'ls', ...extra, '--filter', 'label='+label, '--format',
    type === 'container' ? '{{.Names}}' : type === 'image' ? '{{.Repository}}:{{.Tag}}' : '{{.Name}}').split('\n').filter(Boolean);
  const containers = list('container', '-a');
  const networks = list('network');
  const volumes = list('volume');
  const images = list('image');
  for (const [actual, allowed] of [[containers,[name,postgres]], [networks,[network,egress]], [volumes,[volume,pgVolume]], [images,[imageTag]]]) {
    if (actual.some(resource => !allowed.includes(resource))) throw new Error('Inventory includes an unexpected labeled resource');
  }
  // Keep Postgres available while the real control plane drains its workers
  // and closes the durable budget. Journal files are outside Docker resources.
  if (containers.includes(name)) {
    if (docker('inspect', '--format', '{{.State.Running}}', name) === 'true') docker('stop', '-t', '30', name);
    docker('container', 'rm', name);
  }
  if (volumes.includes(volume) && networks.includes(network)) {
    const runtimes = docker('container', 'ls', '-aq', '--filter', 'label=open-science.web.runtime=true',
      '--filter', 'volume='+volume).split('\n').filter(Boolean);
    for (const id of runtimes) {
      const runtime = JSON.parse(docker('container', 'inspect', '--format', '{{json .HostConfig}}', id));
      if (runtime.NetworkMode !== network || !runtime.Mounts?.length
          || runtime.Mounts.some(m => m.Type !== 'volume' || m.Source !== volume || !m.VolumeOptions?.Subpath)) {
        throw new Error('Unexpected container is attached to the benchmark volume');
      }
      docker('container', 'rm', '-f', id);
    }
  }
  if (containers.includes(postgres)) {
    if (docker('inspect', '--format', '{{.State.Running}}', postgres) === 'true') docker('stop', '-t', '10', postgres);
    docker('container', 'rm', postgres);
  }
  for (const owned of networks) docker('network', 'rm', owned);
  for (const owned of volumes) docker('volume', 'rm', owned);
  for (const owned of images) docker('image', 'rm', owned);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const state = process.argv[2];
  if (!state || !path.isAbsolute(state)) throw new Error('Provide the absolute launcher state directory');
  cleanupResources(JSON.parse(await fs.readFile(path.join(state, 'resources.json'))));
  console.log('Benchmark Docker resources removed; budget and host evidence preserved.');
}
