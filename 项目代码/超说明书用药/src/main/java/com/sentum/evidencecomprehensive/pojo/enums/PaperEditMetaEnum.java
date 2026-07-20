package com.sentum.evidencecomprehensive.pojo.enums;

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
public enum PaperEditMetaEnum {
    PAPER_EDIT_TITLE_1("1", "PICO", "1 研究问题和纳入标准是否包括了PICO部分？"),
    PAPER_EDIT_TITLE_2("2", "*研究方法的确定", "2* 是否声明在系统评价实施前确定了系统评价的研究方法？对于与研究方案不一致处是否进行说明？"),
    PAPER_EDIT_TITLE_3("3", "文献纳入类型说明", "3 系统评价作者在纳入文献时是否明确地说明纳入研究的类型？"),
    PAPER_EDIT_TITLE_4("4", "*检索策略全面", "4* 系统评价作者是否采用了全面的检索策略？"),
    PAPER_EDIT_TITLE_5("5", "双人独立筛选文献", "5 是否采用双人重复式文献选择？"),
    PAPER_EDIT_TITLE_6("6", "双人独立提取数据", "6 是否采用双人重复式数据提取？"),
    PAPER_EDIT_TITLE_7("7", "*排除文献原因说明", "7* 系统评价作者是否提供了排除文献清单并说明其原因？"),
    PAPER_EDIT_TITLE_8("8", "特征要素描述", "8 系统评价作者是否详细地描述了纳入的研究？"),
    PAPER_EDIT_TITLE_9("9", "*偏倚评估工具", "9* 系统评价作者是否采用合适工具评估每个纳入研究的偏倚风险？"),
    PAPER_EDIT_TITLE_10("10", "报告研究资助来源", "10 系统评价作者是否报告被纳入研究的资助来源？"),
    PAPER_EDIT_TITLE_11("11", "*Meta分析统计方法", "11* 作meta分析时，系统评价作者是否采用了合适的统计方法合并研究结果？"),
    PAPER_EDIT_TITLE_12("12", "偏倚风险分析", "12 作meta分析时，系统评价作者是否评估了每个纳入研究的偏倚风险对meta分析结果或其它证据综合结果潜在的影响？"),
    PAPER_EDIT_TITLE_13("13", "*偏倚风险影响讨论", "13* 系统评价作者解释或讨论每个研究结果时是否考虑纳入研究的偏倚风险？"),
    PAPER_EDIT_TITLE_14("14", "异质性讨论", "14 系统评价作者是否对研究结果的任何异质性进行合理的解释和讨论？"),
    PAPER_EDIT_TITLE_15("15", "*发表偏倚对定量合并影响", "15* 如果系统评价作者进行定量合并，是否对发表偏倚（小样本研究偏倚）进行充分的调查，并讨论其对结果可能的影响？"),
    PAPER_EDIT_TITLE_16("16", "利益冲突", "16 系统评价作者是否报告了所有潜在利益冲突的来源，包括所接受的任何用于制作系统评价的资助？");

    private final String num;
    private final String title;
    private final String titleTips;

    PaperEditMetaEnum(String num, String title, String titleTips) {
        this.num = num;
        this.title = title;
        this.titleTips = titleTips;
    }

    private static final Map<String, PaperEditMetaEnum> cache;

    static {
        cache = Arrays.stream(PaperEditMetaEnum.values()).collect(Collectors.toMap(PaperEditMetaEnum::getNum, Function.identity()));
    }

    public static PaperEditMetaEnum of(String num) {
        return cache.get(num);
    }
}
