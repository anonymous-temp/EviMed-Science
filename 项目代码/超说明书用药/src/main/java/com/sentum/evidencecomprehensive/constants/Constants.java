package com.sentum.evidencecomprehensive.constants;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Description: 公用常量类
 * DateTime: 2024/3/26
 */
public final class Constants {

    private Constants() {
    }
    // ########################### redis  ############################
    public static final String REPORT_TOKEN = "reports_token_";
    
    // ########################### 文件后缀  ############################
    public static final String PDF_SUFFIX = ".pdf";
    
    public static final String PNG_SUFFIX = ".png";

    //####################  sftp 时间设置  ####################
    public static final int SESSION_TIMEOUT = 10000;
    public static final int CHANNEL_TIMEOUT = 5000;

    // ######################## 文献 ###################
    // 0, 1, 2, 14, 3, 4, 5, 6, 7, 8, 11, 12, 9, 10, 13
    //0-Review；1-case-report/case-series；3-Meta/系统评价；4-RCT/nRCT；5-观察性研究；6-经济学研究；7-临床试验；9-基础研究
    public final static List<String> OTHER_LITERATURE_TYPE = Arrays.asList("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "13", "14");
    public final static List<String> ECONOMY_LITERATURE_TYPE = Collections.singletonList("12");
    public final static List<String> PAPER_LIST_LITERATURE_TYPE = Arrays.asList("0", "1", "2", "3", "4", "5", "6", "7", "11", "12");
//    public final static List<String> PAPER_LIST_LITERATURE_TYPE = Arrays.asList("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11");
    public final static List<String> ALG_STUDY_TYPES_META_RCT_ECONOMY = Arrays.asList("0", "2", "12");
    public final static List<Integer> META_HIGH_QUALITY_TERM = Arrays.asList(2, 4, 7, 9, 11, 13, 15);
    public final static List<String> PAPER_ZH_TYPE = Arrays.asList("北大核心", "南大核心", "科技核心", "CSCD", "其他");
    public final static List<String> PAPER_EN_TYPE = Arrays.asList("1", "2", "3", "4", "5", "其他");
    public final static String[] PAPER_TYPE_NAME = {
            "系统综述/Meta分析",
            "随机对照试验",
            "队列研究",
            "临床试验",
            "传统综述",
            "病例对照研究",
            "横断面研究",
            "病例系列",
            "病例报告",
            "专家意见和评论",
            "动物实验",
            "体外实验",
            "指南/共识"
    };


    // ######################## 质量评价结果 ###################
    public static final List<String> QUALITY_RESULT = Arrays.asList("是", "否", "部分是", "不适用", "L", "H", "NC");

    // ######################## 模型类型 ###################
    // 百炼
    public static final String DEEPSEEK_V3_2 = "deepseek-v3.2-exp";
    public static final String QWEN3_MAX_600_PRM = "qwen3-max";
    public static final String QWEN3_MAX_2025_09_23_60_PRM = "qwen3-max-2025-09-23";
    public static final String QWEN3_235B_A22B_INSTRUCT_2507 = "qwen3-235b-a22b-instruct-2507";
    public static final String QWEN_MT_PLUS = "qwen-mt-plus";
    // chat any where
    public static final String GPT_4o_2024_11_20 = "gpt-4o-2024-11-20";
    public static final String GPT_4o = "gpt-4o";
    
    // ######################## 标点符号 ###################
    public final static String SING_COMMA = "，";
    public final static String SING_DOT = "。";
    public static final String PAD_COMMA = ",";
    public static final String PAD_SEMICOLON = ";";
    public static final String PAD_DOT = ".";
    public static final String PAD_LEFT_SLASH = "/";
    
    //#####################  首页弹框  ######################
    // 首页弹框条件存储
    public static final String EVIDENCE_ZTE_REPORT_CONDITIONID_KEY = "evidence:report:";

    //####################  日志过滤表名单  ####################
    public final static List<String> LOG_FILTER_METHOD_NAME = Arrays.asList(
            "/evidence-api/super-manual-api/createPc",
            "/evidence-api/super-manual-api/showPc",

            "/evidence-api/adverse-api/info",
            "/evidence-api/adverse-api/drug-safe-info-jd",
            
            "/evidence-api/retrieval-api/acquire-LG",
            "/evidence-api/retrieval-api/synonym",
            "/evidence-api/retrieval-api/disease",
            "/evidence-api/retrieval-api/edit-LG",
            
            "/evidence-api/guide-api/list",
            
            "/evidence-api/paper-api/type-num-list",
            "/evidence-api/paper-api/list",
            "/evidence-api/paper-api/get/pdf",
            
            "/evidence-api/mail-api/list",
            
            "/evidence-api/question-api/list",
            
            "/evidence-api/report-api/show"
    );
}
