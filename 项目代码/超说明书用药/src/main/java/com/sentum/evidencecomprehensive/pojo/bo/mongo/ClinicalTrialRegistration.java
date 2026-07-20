package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import com.alibaba.fastjson.JSONObject;
import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;
import java.util.Map;

/**
 * 临床试验mongo对应实体类--clinicalTrial
 * @author zgm
 */
@Data
@Document("clinical_trial_registration_new")
public class ClinicalTrialRegistration {
    @Id
    private String id;
    /**
     * 来源库
     */
    @Field("belong")
    private String belong;
    /**
     * 登记号
     */
    @Field("register_no")
    private String registerNo;
    /**
     * 试验题目
     */
    @Field("public_title")
    private String publicTitle;
    /**
     * 招募状态
     */
    @Field("recruitment_status")
    private String recruitmentStatus;
    /**
     * 注册时间
     */
    @Field("register_date")
    private String registerDate;
    /**
     * 试验阶段
     */
    @Field("study_phase")
    private String studyPhase;
    /**
     * 样本量
     */
    @Field("sample_size")
    private String sampleSize;
    /**
     * 干预措施
     */
    @Field("intervention")
    private List<Map<String, Object>> intervention;
    /**
     * 适应症
     */
    @Field("condition")
    private List<String> condition;
    /**
     * 关联文章
     */
    @Field("reference")
    private List<Map<String, String>> reference;

    /**
     * who类型的临床试验的原文链接
     */
    private String url;

    /**
     * 临床试验研究结果
     */
    @Field("study_results")
    private Boolean studyResults;
    /**
     *  研究类型
     */
    @Field("study_type")
    private String studyType;

    /**
     * 中文URL
     */
    @Field("register_url")
    private String registerUrl;

    @Field("last_update_date")
    private String lastUpdateDate;

    /**
     * 不良反应事件
     */
    @Field("adverse_events")
    private JSONObject adverseEvents;

    /**
     * 实施单位
     */
    @Field("primary_sponsor")
    private String primarySponsor;
}
