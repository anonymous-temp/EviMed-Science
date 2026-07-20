package com.sentum.drugsafe.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;
import java.util.Map;

/**
 * @author zgm
 * 初筛筛选请求接收的实体类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("screen_request")
public class ScreenRequest {
    /**
     * 当前检索的id会返回给前端用于存储初筛条件，如果未传值后台生成并返回给前台前台用于请求
     */
    @Id
    private String screenId;

    private Long userId;

    /**
     * 通用检索或检索式接收参数的字段
     */
    private String generalOrFineScreen;

    /**
     * 综合搜索
     */
    private String muityQueryStr;

    /**
     * 检索接收字段或超说明书快速检索接收字段
     */
    private Map<String, List<String>> screenMap;

    /**
     * 用户本次操作排除的同义词
     */
    private List<String> excludeSynonyms;

    /**
     * 判断用户的检索方式：1-快速检索；2-检索式检索；3-picos初筛；-1-快速检索且不使用系统推荐的词
     */
    private Integer type;

    /**
     * 输入词翻译判定，1-翻译，2-不翻译
     */
    private Integer translateStatus;

    /**
     * 判断是否使用同义词，1-使用，2-不使用
     */
    private Integer synonymStatus;

    /**
     * 根据检索数据拼接而成的string类型的query
     */
    private String screenQuery;
    /**
     * 初筛时间
     */
    private Long screenTime;
    /**
     * 判断是否为定向搜索，0全部搜索（默认）；1-文献搜索；2-指南；3-说明书；4-不良反应；5-临床实验
     */
    private Integer judgmentOrientation;
    /**
     * true保留，false不保留
     */
    private Boolean retain;
    /***
     * 检索范围
     * 、0全部
     * 1标题
     * 2关键词
     * 3摘要
     * 4题关摘
     * 5期刊
     * 6作者
     * 7机构
     */
    private int searchRange;

    /**
     * 0 默认
     * 1 搜文献
     */
    private int queryFrom;

    private List<List<String>> queryWords;

    private List<List<String>> transQueryWords;

    //疾病和药物是OR 还是 AND
    private boolean xOr;
}
