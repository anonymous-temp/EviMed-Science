package com.sentum.evidencecomprehensive.constants;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/17
 */
public class RedisKeyConstant {

    /**
     * 项目公共头
     */
    private static final String PROJECT_PREFIX = "chaoshu:rag:";
    
    public static final String INSTRUCTION_INFO = "instruction:info:%s";
    
    public static final String PAPER_TRANS = "paper:trans:%s";

    public static String getKey(String str, Object... objects) {
        return PROJECT_PREFIX + String.format(str, objects);
    }
}
