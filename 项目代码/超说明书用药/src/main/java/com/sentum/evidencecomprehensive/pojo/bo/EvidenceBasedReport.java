package com.sentum.evidencecomprehensive.pojo.bo;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import lombok.Data;

/**
 * @Description: 生成word实体类
 */

@Data
public class EvidenceBasedReport {

    /**
     * 全局唯一id
     */
    private String id;

    /**
     *  报告标题
     */
    private String title;

    /**
     * XX药品名称卫生技术评估（HTA）报告摘要标题
     */
    private String title1;

    /**
     * XX药品名称卫生技术评估（HTA）报告正文标题
     */
    private String title2;

    /**
     * 说明书信息
     */
    private JSONArray instructions;

    /**
     * 推荐等级
     */
    private String recommendLevel;

    /**
     * 证据等级
     */
    private String evidenceLevel;

    /**
     * 卫生技术评估（HTA）报告摘要
     */
    private JSONObject htaDigest;

    /**
     * 卫生技术评估（HTA）报告正文
     */
    private JSONObject htaMain;

    /**
     * 参考文献模块
     */
    private JSONObject bibliography;
}
