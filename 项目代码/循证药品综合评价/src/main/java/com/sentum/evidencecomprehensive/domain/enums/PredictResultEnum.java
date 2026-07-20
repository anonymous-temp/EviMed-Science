package com.sentum.evidencecomprehensive.domain.enums;

import lombok.Getter;

import java.util.Arrays;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/6/5
 */
@Getter
public enum PredictResultEnum {
    
    YES("是", 1),
    PART_YES("部分是", 1),
    NO("否", 1),
    NOT_APPLICABLE_NUM("不适用", 1);
    
    private final String result;
    private final int num;

    PredictResultEnum(String result, int num) {
        this.result = result;
        this.num = num;
    }

    private static final Map<String, PredictResultEnum> cache;

    static {
        cache = Arrays.stream(PredictResultEnum.values()).collect(Collectors.toMap(PredictResultEnum::getResult, Function.identity()));
    }

    public static PredictResultEnum of(String result) {
        return cache.get(result);
    }
    
}
