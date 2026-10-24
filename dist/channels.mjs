export const InputChannel = Object.freeze({ First: 'input-1', Second: 'input-2', Mix: 'mix' });

// Select before downmixing so a silent or inverted interface channel cannot erase the mic.
export function selectChannel(channels, selection = InputChannel.First) {
  if (!channels.length) return new Float32Array();
  if (selection !== InputChannel.Mix) return channels[selection === InputChannel.Second && channels.length > 1 ? 1 : 0];
  const samples = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let i = 0; i < samples.length; i++) samples[i] += channel[i] / channels.length;
  }
  return samples;
}

export function channelLevels(channels) {
  return channels.map(channel => {
    let energy = 0;
    for (const value of channel) energy += value * value;
    return 20 * Math.log10(Math.max(1e-8, Math.sqrt(energy / Math.max(1, channel.length))));
  });
}
