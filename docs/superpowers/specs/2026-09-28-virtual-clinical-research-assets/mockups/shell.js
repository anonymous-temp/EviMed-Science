// The one sidebar every 虚拟临研 mockup shares: the live EviMed Science order, with 「虚拟临研」 directly
// below 「科研工具」 and above 「循证 GEO」. <body data-nav="vcr" data-recent="a">. Design renders, not screenshots.
(function () {
  var NAV = [
    ["chat", "square-pen", "新对话"],
    ["frontier", "newspaper", "前沿动态"],
    ["tools", "bot", "科研工具"],
    ["vcr", "users-round", "虚拟临研"],
    ["geo", "radar", "循证 GEO"],
    ["kb", "folder-tree", "知识库"],
    ["memory", "brain", "记忆胶囊"],
    ["auto", "orbit", "主动科研"],
  ];
  function row(item, on) {
    return '<a class="' + (item[0] === on ? "on" : "") + '"><svg data-i="' + item[1] + '"></svg><span>' + item[2] + "</span></a>";
  }
  function build() {
    var b = document.body;
    var host = document.querySelector("[data-shell]");
    if (!host) return;
    var on = b.getAttribute("data-nav") || "";
    var recentOn = b.getAttribute("data-recent") || "";
    var groups = [
      ["EV-201 二线 NSCLC", [["单臂 II 期 + 外部对照可行性", "a"], ["对照组 PFS 参数来源", "b"]]],
      ["GLP-1 周制剂 III 期", [["样本量与脱落情景", "c"]]],
      ["我的研究", [["二甲双胍对心血管结局的影响", "d"]]],
    ];
    var html = "";
    html += '<div class="brand"><img src="img/evimed-logo.svg" alt=""><span class="word">EviMed</span><span class="sp"></span>' +
      '<a class="ibtn" style="position:relative"><svg data-i="bell"></svg><i style="position:absolute;top:7px;right:8px;width:6px;height:6px;border-radius:3px;background:var(--safety)"></i></a>' +
      '<a class="ibtn"><svg data-i="panel-left"></svg></a></div>';
    html += '<nav class="nav" style="margin-top:14px">' + NAV.map(function (n) { return row(n, on); }).join("") + "</nav>";
    html += '<div class="sec">最近<span class="sp"></span><svg data-i="search" class="i xs"></svg></div><div class="recent">' +
      groups.map(function (g) {
        return '<div class="proj"><svg data-i="' + (g[0] === "我的研究" ? "folder" : "users-round") + '" class="i xs"></svg>' + g[0] + "</div>" +
          g[1].map(function (r) { return '<a style="padding-left:32px" class="' + (r[1] === recentOn ? "on" : "") + '">' + r[0] + "</a>"; }).join("");
      }).join("") + "</div>";
    html += '<div class="me"><div class="avatar">林</div><div class="who"><b>林研究员</b><span>临床研究中心</span></div><span class="sp"></span><svg data-i="settings" style="color:var(--text-3)"></svg></div>';
    host.innerHTML = html;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
