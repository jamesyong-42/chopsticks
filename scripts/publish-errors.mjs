const ansiEscape = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function isAlreadyPublishedError(output, version) {
  const plainOutput = output.replace(ansiEscape, '');

  return (
    /(?:\[?E403\]?|code E403)[\s\S]*cannot publish over (?:the )?previously published versions?/i.test(plainOutput) &&
    plainOutput.includes(version)
  );
}
