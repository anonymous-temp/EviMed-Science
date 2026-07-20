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
public enum PaperEditEconomyEnum {
    PAPER_EDIT_TITLE_1("1", "1 将研究确定为经济评估, 并包含干预措施"),
    PAPER_EDIT_TITLE_2("2", "2 提供结构化摘要, 突出背景、关键方法、结果和相关分析"),
    PAPER_EDIT_TITLE_3("3", "3 介绍研究背景、研究问题及其与卫生政策或实践决策的相关性"),
    PAPER_EDIT_TITLE_4("4", "4 说明是否制定了卫生经济分析计划及其获取途径"),
    PAPER_EDIT_TITLE_5("5", "5 描述研究人群特征（例如年龄范围、人口学特征、社会经济或临床特征）"),
    PAPER_EDIT_TITLE_6("6", "6 提供可能影响调查结果的相关背景信息"),
    PAPER_EDIT_TITLE_7("7", "7 描述对照措施或策略以及选择原因"),
    PAPER_EDIT_TITLE_8("8", "8 说明研究采用的角度及其选择原因"),
    PAPER_EDIT_TITLE_9("9", "9 说明研究的时间范围及其选择原因"),
    PAPER_EDIT_TITLE_10("10", "10 报告贴现率及其选择原因"),
    PAPER_EDIT_TITLE_11("11", "11 描述使用哪些结果作为获益和危害的衡量标准"),
    PAPER_EDIT_TITLE_12("12", "12 描述如何衡量/测量结果（获益和危害）"),
    PAPER_EDIT_TITLE_13("13", "13 描述用于衡量和评估结果的人群和方法"),
    PAPER_EDIT_TITLE_14("14", "14 描述如何测算成本"),
    PAPER_EDIT_TITLE_15("15", "15 报告估计资源数量和单位，成本的日期, 以及货币和换算年份"),
    PAPER_EDIT_TITLE_16("16", "16 如果使用模型, 详细描述模型原理以及选择该模型的原因, 报告模型是否公开可用以及获取途径"),
    PAPER_EDIT_TITLE_17("17", "17 描述用于分析或转换数据的方法、外推方法以及用于验证所使用模型的方法"),
    PAPER_EDIT_TITLE_18("18", "18 描述用于估计研究结果如何因亚组而异的方法"),
    PAPER_EDIT_TITLE_19("19", "19 描述结果对不同人群（例如社会环境因素、疾病特征、地理位置等）的影响，和说明调整成本效果阈值来反映优先人群，解决分配问题"),
    PAPER_EDIT_TITLE_20("20", "20 描述不确定性的分析方法"),
    PAPER_EDIT_TITLE_21("21", "21 描述让患者或服务接受者、公众、社区或利益相关者（如临床医生或支付方）参与研究设计的方法"),
    PAPER_EDIT_TITLE_22("22", "22 报告分析所用的参数信息（例如参数值、范围、来源）, 包括不确定性或参数分布假设"),
    PAPER_EDIT_TITLE_23("23", "23 报告主要类别的成本和结局指标的平均值, 并以最合适的方式进行总结"),
    PAPER_EDIT_TITLE_24("24", "24 描述分析判断、输入数据或预测的不确定性如何影响结果。报告所选的贴现率和时间范围带来的影响（如果适用）"),
    PAPER_EDIT_TITLE_25("25", "25 报告患者或服务对象、公众、社区或利益相关者的参与对研究方法或研究结果造成的差异"),
    PAPER_EDIT_TITLE_26("26", "26 报告关键发现、局限性、研究未考虑的伦理或公平性, 以及这些因素对患者、决策或实践的影响"),
    PAPER_EDIT_TITLE_27("27", "27 描述研究的资助方式以及资助者在分析的确定、设计、实施和报告中的作用"),
    PAPER_EDIT_TITLE_28("28", "28 根据期刊或国际医学期刊编辑委员会的要求报告作者的利益冲突");
    
    private final String num;
    private final String title;

    PaperEditEconomyEnum(String num, String title) {
        this.num = num;
        this.title = title;
    }

    private static final Map<String, PaperEditEconomyEnum> cache;

    static {
        cache = Arrays.stream(PaperEditEconomyEnum.values()).collect(Collectors.toMap(PaperEditEconomyEnum::getNum, Function.identity()));
    }

    public static PaperEditEconomyEnum of(String num) {
        return cache.get(num);
    }
    
}
