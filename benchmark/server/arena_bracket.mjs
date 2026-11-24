export function tournamentState(ids, decisions) {
  if (ids.length !== 4 || new Set(ids).size !== 4 || decisions.length > 5) throw Error('Invalid tournament');
  const battles = [], winners = [], losers = [];
  for (let step = 0; step < 5; step++) {
    const pair = step === 0 ? ids.slice(0, 2) : step === 1 ? ids.slice(2, 4) : step === 2 ? winners.slice(0, 2)
      : step === 3 ? losers.slice(0, 2) : [losers[2], winners[3]];
    battles.push(pair);
    if (decisions[step] === undefined) return { step: step + 1, pair, battles, complete: false };
    if (!pair.includes(decisions[step])) throw Error('Decision does not belong to its tournament battle');
    winners.push(decisions[step]); losers.push(pair.find(id => id !== decisions[step]));
  }
  return { step: 5, pair: null, battles, complete: true, ordering: [winners[2], winners[4], losers[4], losers[3]] };
}
