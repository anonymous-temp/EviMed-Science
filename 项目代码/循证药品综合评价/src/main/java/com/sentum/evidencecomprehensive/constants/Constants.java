package com.sentum.evidencecomprehensive.constants;

import cn.hutool.core.lang.Pair;
import cn.hutool.core.map.MapUtil;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * 通用常量信息
 */
public class Constants {
    
    //#################### redis key  ####################
    public final static String ACCESS_TOKEN = "access_token_";
    public final static String ACCESS_USERID = "access_userid_";
    public final static String PHONE_CODE = "check_code_";
    public static final String USER_PREFIX = "info:user_prefix_";
    public static final String REPORT_VERSION = "reportVersion";
    public static final String TEMPLATE_MODI = "pharmacy:rag:template_modi:id_";
    public static final String TEMPLATE_ORI = "pharmacy:rag:template_original:id_";
    public static final String OVER_REPORT_CONTENT = "pharmacy:rag:over_report_content:id_";
    public static final String REPORT_RIGHT_INFO = "report_right_info:id_";

    public static final String REPORT_TOKEN = "report_token_";
    
    public static final String KEY_INSTRUCTION = "xunzheng:instruction:";

    public static final long TOKEN_AND_INFO_EXPIRE_30 = 30 * 24 * 60 * 60; // 30 days
    public static final long TOKEN_AND_INFO_EXPIRE_7 = 7 * 24 * 60 * 60; // 7 days
    
    //####################  redis dir key ####################
    public static final String EVIDENCE_ZTE_REPORT_CONDITION_KEY = "evidence:zte:report:";
    public static final String EVIDENCE_ZTE_REPORT_KEY = "evidence:zte:report:";

    // ######################## 标点符号 ###################
    public final static String SING_COMMA = "，";
    public final static String SING_DOT = "。";
    public static final String PAD_COMMA = ",";
    public static final String PAD_SEMICOLON = ";";
    public static final String PAD_LEFT_SLASH = "/";
    
    // ######################## hta ###################
    public final static List<String> TRANS_PDF_SOURCES = Arrays.asList("NICE", "SMC", "AWMSG", "CADTH", "IQWIG", "EUnetHTA", "INAHTA");

    // ######################## 文献 ###################
    // 0, 1, 2, 14, 3, 4, 5, 6, 7, 8, 11, 12, 9, 10, 13
    //0-Review；1-case-report/case-series；3-Meta/系统评价；4-RCT/nRCT；5-观察性研究；6-经济学研究；7-临床试验；9-基础研究
    public final static List<String> OTHER_LITERATURE_TYPE = Arrays.asList("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "13", "14");
    public final static List<String> ECONOMY_LITERATURE_TYPE = Collections.singletonList("12");
    public final static List<String> PAPER_LIST_LITERATURE_TYPE = Arrays.asList("0", "1", "2", "3", "4", "5", "6", "7", "11", "12");
    public final static List<String> PAPER_ZH_TYPE = Arrays.asList("北大核心", "南大核心", "科技核心", "CSCD", "其他");
    
    // 3 Meta  4 RCT  6 经济类 目前只支持这 4 种类型
    public final static List<Integer> ALG_STUDY_TYPES_META = Collections.singletonList(0);
    public final static List<Integer> ALG_STUDY_TYPES_RCT = Collections.singletonList(2);
    public final static List<Integer> ALG_STUDY_TYPES_ECONOMY = Collections.singletonList(12);
    public final static List<String> ALG_STUDY_TYPES_META_RCT_ECONOMY = Arrays.asList("0", "2", "12");
    public final static List<Integer> META_HIGH_QUALITY_TERM = Arrays.asList(2, 4, 7, 9, 11, 13, 15);
    public final static List<Integer> META_LOW_QUALITY_TERM = Arrays.asList(1, 3, 5, 6, 8, 10, 12, 14, 16);

    // ######################## regex ###################
    public final static String REGEX_NOT_CHARACTER = "[^a-zA-Z0-9]";
    
    //#################### 文件ext  ####################
    public static final String FILE_EXT_NAME_XML = ".xml";
    public static final String FILE_EXT_NAME_JSON = ".json";
    public static final String FILE_EXT_NAME_PDF = ".pdf";
    public static final String PAD_DOT = ".";
    
    //#################### 日期格式  ####################
    public static final String DATE_FORMAT = "yyyy-MM-dd";
    public static final String DATETIME_FORMAT = "yyyy-MM-dd HH:mm:ss";
    public static final String DATETIME_FORMAT_WITH_T = "yyyy-MM-dd'T'HH:mm:ss";
    public static final String DATETIME_SHORT_FORMAT = "yyyyMMddHHmmss";
    public static final String DATETIME_SHORT_MILLISECOND_FORMAT = "yyyyMMddHHmmssSSS";
    public static final String DATETIME_SHORT_SECOND_FORMAT = "YYYYMMDDhh24miss";
    public static final String DATE_SHORT_FORMAT = "yyyyMMdd";
    public static final String YEAR_MONTH_FORMAT = "yyyyMM";
    public static final String TIME_FORMAT = "HH:mm:ss";
    public static final String TIME_SHORT_FORMAT = "HHmmss";
    public static final String HHMMSSSSS = "HHmmssSSS";
    
    //#################### 课题下载文件夹名称  ####################
    public static final String localexcelpath = "excel-clinical";
    public static final String EXCEL_FILE_PATH_PAPER = "文献";
    public static final String EXCEL_FILE_PATH_GUIDE = "指南共识";
    public static final String EXCEL_FILE_PATH_INSTRUCTION = "说明书";
    public static final String EXCEL_FILE_PATH_ADRS = "不良反应";
    public static final String EXCEL_FILE_PATH_HTA = "其他国家或地区HTA报告";
    public static final String EXCEL_FILE_PATH_CLINICAL = "临床试验";
    
    //#################### 排除理由  ####################
    public static final List<Pair<String, String>> PAIRS = Arrays.asList(Pair.of("1", "研究主题（药品介绍、药物机制等主题）不相关"), 
            Pair.of("2", "文献综述/评论/新闻"),
            Pair.of("3", "数据缺失"), 
            Pair.of("4", "重复文献"), 
            Pair.of("5", "研究主题不相关"), 
            Pair.of("6", "非经济性评价文献（非成本-效果/效益/效用，非最小成本）研究"),
            Pair.of("7", "已纳入国外组织HTA报告的文献"),
            Pair.of("8", "其他"));
    public static final Map<String, String> excludeReasonMap = MapUtil.of(PAIRS.toArray(new Pair[0]));

    //####################  sftp 时间设置  ####################
    public static final int SESSION_TIMEOUT = 10000;
    public static final int CHANNEL_TIMEOUT = 50000;

    // ######################## 模型类型 ###################
    public static final String GPT_4o_2024_11_20 = "gpt-4o-2024-11-20";
    public static final String GPT_4o = "gpt-4o";
    public static final String QWEN3_235B_A22B_INSTRUCT_2507 = "qwen3-235b-a22b-instruct-2507";
    public static final String QWEN3_MAX_2025_09_23 = "qwen3-max-2025-09-23";
    public static final String QWEN_MT_PLUS = "qwen-mt-plus";
    
    //#####################  common #####################
    public static final List<String> NEES_WIPE_OUT = Arrays.asList("方案", "手术");

    //####################  日志过滤表名单  ####################
    public final static List<String> LOG_FILTER_METHOD_NAME = Arrays.asList("createEvidenceBasedReport", 
            "aiSearchLg", 
            
            "/evidence-api-based/mail-api/list", 
            
            "/evidence-api-based/adverse-api/info",
            
            "/evidence-api-based/clinical-trials-api/list", 
            
            "/evidence-api-based/guide-api/list", 
            
            "/evidence-api-based/question-api/list", 
            
            "/evidence-api-based/retrieval-api/synonym", 
            
            "/evidence-api-based/paper-api/list",
            "/evidence-api-based/paper-api/get/pdf",
            "/evidence-api-based/paper-api/get/alg/pdf",
            "/evidence-api-based/paper-api/type-num-list",
            
            "/evidence-api-based/pharmacy-api/search-htaReport",

            "/evidence-api-based/report-api/edit/multi",
            "/evidence-api-based/report-api/download/new",
            "/evidence-api-based/report-api/report-right",
            "/evidence-api-based/report-api/show"
            );
    
    /*********
    *  质量评价结果
    **********/
    public static final List<String> QUALITY_RESULT = Arrays.asList("是", "否", "部分是", "不适用", "L", "H", "NC");

}
