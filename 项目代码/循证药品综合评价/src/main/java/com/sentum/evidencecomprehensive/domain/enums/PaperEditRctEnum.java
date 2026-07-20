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
public enum PaperEditRctEnum {
    PAPER_EDIT_TITLE_1("1", "选择偏倚-随机序列的产生"),
    PAPER_EDIT_TITLE_2("2", "选择偏倚-分配隐藏"),
    PAPER_EDIT_TITLE_3("3", "实施偏倚-研究者和受试者施盲"),
    PAPER_EDIT_TITLE_4("4", "测量偏倚-研究结局盲法评价"),
    PAPER_EDIT_TITLE_5("5", "随访偏倚-结果数据的完整性"),
    PAPER_EDIT_TITLE_6("6", "报告偏倚"),
    PAPER_EDIT_TITLE_7("7", "其他偏倚");
    
    private final String num;
    private final String title;

    PaperEditRctEnum(String num, String title) {
        this.num = num;
        this.title = title;
    }

    private static final Map<String, PaperEditRctEnum> cache;

    static {
        cache = Arrays.stream(PaperEditRctEnum.values()).collect(Collectors.toMap(PaperEditRctEnum::getNum, Function.identity()));
    }

    public static PaperEditRctEnum of(String num) {
        return cache.get(num);
    }
    
}
