// 本机没装 LEAN（dotnet / LEAN / engine/.venv 缺一样）时，需要真实 LEAN 的测试跳过而不是失败。
// HELM_REQUIRE_LEAN=1 时仍然算失败（装好引擎的机器上用它确认没有被悄悄跳过）。
export function leanSkip(check, status) {
  const why = (status.missing || []).join(', ');
  if (process.env.HELM_REQUIRE_LEAN === '1') return check('LEAN ready', false, `missing ${why}`);
  console.log(`SKIP (LEAN not installed: missing ${why}) — the real-LEAN part of this test was not run; install with scripts/setup.sh`);
}
