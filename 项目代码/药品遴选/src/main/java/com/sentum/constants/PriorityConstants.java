package com.sentum.constants;

import java.util.HashMap;
import java.util.Map;

public class PriorityConstants {
    // 优先级级别定义
    public static final int PRIORITY_CRITICAL = 100;    // 紧急请求
    public static final int PRIORITY_HIGH = 80;         // 高优先级
    public static final int PRIORITY_NORMAL = 50;       // 正常优先级
    public static final int PRIORITY_LOW = 30;          // 低优先级
    public static final int PRIORITY_BACKGROUND = 10;   // 后台任务

    // 业务场景优先级映射
    public static final Map<String, Integer> BUSINESS_PRIORITY_MAP = new HashMap<String, Integer>() {{
        put("实时查询", PRIORITY_HIGH);
        put("批量处理", PRIORITY_LOW);
        put("紧急诊断", PRIORITY_CRITICAL);
        put("常规分析", PRIORITY_NORMAL);
        put("数据同步", PRIORITY_BACKGROUND);
    }};
}