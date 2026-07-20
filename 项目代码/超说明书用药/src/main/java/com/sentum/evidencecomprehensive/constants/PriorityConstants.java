package com.sentum.evidencecomprehensive.constants;

import java.util.HashMap;
import java.util.Map;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/9/18
 */
public class PriorityConstants {
    // 优先级级别定义
    public static final int PRIORITY_CRITICAL = 0;    // 紧急请求
    public static final int PRIORITY_HIGH = 2;         // 高优先级
    public static final int PRIORITY_NORMAL = 8;       // 正常优先级
    public static final int PRIORITY_LOW = 15;          // 低优先级
    public static final int PRIORITY_BACKGROUND = 20;   // 后台任务

    // 业务场景优先级映射
    public static final Map<String, Integer> BUSINESS_PRIORITY_MAP = new HashMap<String, Integer>() {{
        put("实时查询", PRIORITY_HIGH);
        put("批量处理", PRIORITY_LOW);
        put("紧急诊断", PRIORITY_CRITICAL);
        put("常规分析", PRIORITY_NORMAL);
        put("数据同步", PRIORITY_BACKGROUND);
    }};
}