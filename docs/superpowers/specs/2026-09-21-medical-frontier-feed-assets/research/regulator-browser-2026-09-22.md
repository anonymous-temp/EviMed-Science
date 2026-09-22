# Regulator pages through a self-hosted headless Chromium (2026-09-22)

Question from the owner: can NMPA / CDE / CMDE / NHC be crawled by our own script instead of the AgentBay cloud browser?

Plain HTTP (curl, desktop Chrome UA) from both networks returns the Ruishu challenge (`$_ts` script):
- nmpa.gov.cn 412, cde.org.cn 202, cmde.org.cn 202, nhc.gov.cn 412 from Beijing (nhc and chp time out from the Taipei dev line);
- chp.org.cn (Pharmacopoeia Commission) answers 200 with a real page from Beijing: no browser needed.

`tools/browser_probe.mjs` (playwright-core, one context, `domcontentloaded` then wait until >= 12 CJK links):

Dev box, Chromium 1208 (new headless), 5 pages, 41 s total including one 25 s wait on a table page:
- NMPA 公告通告 3.9 s, 79 links, 23 dates; NMPA 其他公告 6.1 s; CDE 指导原则 2.5 s; CMDE 指导原则 1.3 s.

Beijing production host, the runtime image's Chromium 153 in a throwaway container (`--memory 1g`), 7 pages, 22 s total:
- NMPA 公告通告 5.3 s (79 links, e.g. 「国家药监局关于注销八珍丸等12个药品注册证书的公告（2026年第92号）」)
- NMPA 说明书修订公告 2.2 s (「国家药监局关于修订肌苷注射剂说明书的公告（2026年第87号）」)
- NMPA 创新药械专题 1.5 s; CDE 指导原则 2.7 s; CMDE 指导原则 2.4 s; NHC 文件 3.2 s; NHC 医政司 0.9 s
- NHC 药政司 (corrected endpoint yaozs/new_index.shtml) 3.5 s, title 药物政策与基本药物制度司.

Ruling: the regulators go through our own `frontier-browser` container on the Beijing host (connectOverCDP, the same interface the AgentBay renderer uses); AgentBay stays as the fallback. Registry fix: `nhc-drug-policy-department` pointed at yzygj (医政司), now yaozs.
