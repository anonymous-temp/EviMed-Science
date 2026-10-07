/**
 * What the deployment's configuration check says, in an operator's words.
 *
 * `/api/ready` reports each check as passed, failed (a named code) or passed
 * with a named warning. The operator console used to print that code as it came
 * (`runtime_mock_forbidden`, `geo_market_unconfigured`) beside a green tick, so
 * the page that is meant to be read when something is wrong showed identifiers
 * (2026-10-07 audit, 设置 · 运维). Each code the check can raise now has one
 * sentence here: what is wrong, and what to change.
 *
 * None of these is a verdict on a run: they describe the deployment's own
 * configuration and the services outside the platform. They are why a check is
 * red or why a green one carries a note, and a test walks the server's source
 * for every code it can emit (`readinessCodesRegistered.test.mjs`) so a code
 * added there without a sentence here fails there.
 */

export const READINESS_ERROR_MESSAGES_ZH = Object.freeze({
  // Sign-in and the first account.
  auth_mode_invalid: '登录方式的配置值不被认可，请检查部署的认证模式。',
  no_login_users: '没有任何可以登录的账号，请先创建一个。',
  bootstrap_user_missing: '没有找到配置的初始管理员账号，请检查初始账号的设置。',
  bootstrap_password_invalid: '初始管理员密码无效，请换一个。',
  bootstrap_password_placeholder: '初始管理员密码还是示例里的占位值，请换成真正的密码。',
  bootstrap_password_too_short: '初始管理员密码太短，请加长。',
  bootstrap_password_environment_forbidden: '生产环境不允许用环境变量设置初始管理员密码，请改用密码文件。',
  evimed_auth_disabled: 'EviMed 主站账号登录没有启用，请检查登录配置。',
  dev_auth_enabled: '开发用的登录入口开着，生产环境必须关闭。',
  session_ttl_invalid: '登录有效期的配置无效。',
  // The address and the browser boundary.
  public_url_missing: '没有配置公开网址。',
  public_url_invalid: '公开网址的配置无效。',
  public_url_https_required: '公开网址必须使用 https。',
  public_url_origin_required: '公开网址只能写到域名，不能带路径。',
  cors_origin_forbidden: '跨域白名单里有不被允许的来源。',
  cors_origin_https_required: '生产环境的跨域来源必须使用 https。',
  cors_origin_invalid: '跨域白名单里有无法识别的来源。',
  cors_origin_local_forbidden: '生产环境的跨域白名单里不能有本机地址。',
  cors_origin_not_exact: '跨域来源必须写成确切的域名，不能带路径或通配符。',
  security_headers_disabled: '安全响应头被关闭了，生产环境必须开启。',
  trusted_proxy_required: '生产环境必须配置可信代理。',
  direct_shell_enabled: '直连命令行开着，生产环境必须关闭。',
  host_shell_enabled: '宿主机命令行开着，生产环境必须关闭。',
  full_approval_enabled: '全部自动批准开着，生产环境必须关闭。',
  persistent_approvals_enabled: '持久批准开着，生产环境必须关闭。',
  // Where the platform keeps its state.
  data_dir_not_directory: '数据目录的路径不是一个目录。',
  data_dir_symlink: '数据目录是符号链接，不被允许，请指向真实目录。',
  data_dir_unavailable: '数据目录读不到或写不进，请检查挂载和权限。',
  production_state_store_not_shared: '生产环境要求用共享数据库保存状态，现在用的是本机文件，请配置数据库。',
  relational_integrity_unverified: '数据库的关系完整性还没有通过校验（有孤立记录或未校验的约束），请先修复。',
  static_asset_unavailable: '找不到前端静态文件，页面打不开。',
  example_bundle_invalid: '内置示例的内容无效，请联系管理员。',
  example_bundle_unavailable: '内置示例不可用，请联系管理员。',
  release_manifest_missing: '找不到发布清单。',
  release_manifest_mismatch: '正在运行的版本和发布清单对不上，请重新部署。',
  resource_limit_invalid: '资源限额的配置无效。',
  resource_limit_inconsistent: '资源限额之间互相矛盾（例如单个文件比整个项目还大），请核对。',
  // Backups.
  backup_not_configured: '这个部署还没有配置备份。',
  backup_mode_invalid: '备份方式的配置值不被认可。',
  backup_dir_missing: '备份目录不存在，请先创建并挂载。',
  backup_dir_not_absolute: '备份目录必须写成绝对路径。',
  backup_dir_not_directory: '备份目录的路径不是一个目录。',
  backup_dir_symlink: '备份目录是符号链接，不被允许，请指向真实目录。',
  backup_dir_inside_data_dir: '备份目录放在了数据目录里，备份会和数据一起丢失，请改到数据目录之外。',
  backup_dir_unavailable: '备份目录读不到或写不进，请检查挂载和权限。',
  backup_encryption_missing: '备份没有配置加密密钥，请配置后再启用。',
  backup_external_unconfirmed: '备份存放在本机之外这件事还没有确认。',
  backup_restore_drill_missing: '备份还没有做过恢复演练，请完成一次并记录。',
  restore_drill_unconfirmed: '恢复演练还没有确认。',
  backup_retention_invalid: '备份保留天数的配置无效。',
  backup_interval_invalid: '备份间隔的配置无效。',
  backup_health_grace_invalid: '备份健康检查的宽限时间配置无效。',
  backup_scheduler_stale: '定时备份已经很久没有成功运行，请查看备份任务。',
  backup_scheduler_unhealthy: '定时备份在报告异常，请查看备份任务的日志。',
  backup_state_missing: '找不到备份状态文件，备份可能从未运行过。',
  backup_state_invalid: '备份状态文件的内容无效。',
  backup_state_path_invalid: '备份状态文件的路径无效。',
  backup_state_symlink: '备份状态文件是符号链接，不被允许。',
  backup_state_unavailable: '备份状态文件读不到，请检查挂载和权限。',
  // The model service, the connectors and the parser.
  deepseek_api_key_missing: '没有配置模型服务的密钥。',
  deepseek_base_url_invalid: '模型服务的地址配置无效。',
  deepseek_model_invalid: '模型名称的配置无效。',
  model_gateway_url_invalid: '模型网关的地址配置无效。',
  model_gateway_internal_url_invalid: '模型网关的内部地址配置无效。',
  model_gateway_limit_invalid: '模型网关的限额配置无效。',
  model_gateway_runtime_mode_invalid: '模型网关的运行时模式配置无效。',
  model_gateway_signing_secret_invalid: '模型网关的签名密钥无效或太短。',
  materials_project_api_key_missing: '没有配置 Materials Project 的密钥。',
  materials_project_api_key_environment_forbidden: '不允许用环境变量提供 Materials Project 的密钥，请改用密钥文件。',
  document_parser_unconfigured: '要求启用文档解析，但没有配置解析服务的地址。',
  openlist_unconfigured: '要求启用网盘接入，但没有配置网盘服务或访问令牌。',
  notification_unconfigured: '要求启用收件箱，但收件箱没有接入。',
  usage_ledger_unconfigured: '要求启用用量账本，但账本没有接入。',
  operator_metrics_token_missing: '没有配置运维指标的访问令牌。',
  operator_metrics_token_invalid: '运维指标的访问令牌无效。',
  operator_metrics_token_placeholder: '运维指标的访问令牌还是示例里的占位值，请换掉。',
  operator_metrics_token_too_short: '运维指标的访问令牌太短，请加长。',
  // Modules whose own invariants are red and whose outside services are warnings.
  evimed_credits_unavailable: '科研额度模块没有就绪（数据库或模块没有接入），请查看日志。',
  evimed_credits_wallet_not_wired: '科研额度的钱包还没有接通，暂时不会扣费；接通后自动恢复。',
  frontier_migration_failed: '前沿动态的数据库升级没有完成，请查看日志。',
  frontier_unavailable: '前沿动态模块没有就绪，请查看日志。',
  frontier_project_missing: '前沿动态使用的内部项目不存在。',
  frontier_operator_unconfigured: '前沿动态没有配置运营账号。',
  frontier_operator_unavailable: '前沿动态使用的运营账号读不到。',
  frontier_plugin_token_unreadable: '知识源插件的访问令牌文件读不到。',
  frontier_worker_missing: '前沿动态的后台循环没有启动。',
  frontier_plugin_unreachable: '知识源插件连不上，前沿动态暂时拿不到新内容；已有内容不受影响。',
  frontier_plugin_incompatible: '知识源插件的版本和平台不匹配，前沿动态暂停读取。',
  frontier_plugin_unconfigured: '没有配置知识源插件，前沿动态没有内容来源。',
  geo_worker_missing: '循证 GEO 的后台循环没有启动，监测和各步骤不会自动推进。',
  geo_worker_loop_missing: '循证 GEO 有一个后台循环没有启动，对应的步骤不会自动推进；请联系管理员。',
  geo_worker_loop_failing: '循证 GEO 有一个后台循环在反复出错，对应的步骤暂停推进；请联系管理员。',
  geo_worker_loop_stalled: '循证 GEO 有一个后台循环停住了，对应的步骤暂停推进；请联系管理员。',
  geo_social_unconfigured: '循证 GEO 没有配置社媒采集服务，读不到社媒帖子。',
  geo_market_unconfigured: '循证 GEO 没有配置媒体采买服务，下单这一步暂时用不了；其余步骤照常。',
})

export const READINESS_ERROR_CODES = Object.freeze(Object.keys(READINESS_ERROR_MESSAGES_ZH))
