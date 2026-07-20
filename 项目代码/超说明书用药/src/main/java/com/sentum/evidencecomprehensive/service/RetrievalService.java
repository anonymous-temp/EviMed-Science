package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.dto.LGYearDto;
import com.sentum.evidencecomprehensive.pojo.dto.ConditionDto;
import com.sentum.evidencecomprehensive.pojo.dto.DrugDto;
import com.sentum.evidencecomprehensive.pojo.dto.OutcomeDto;
import com.sentum.evidencecomprehensive.pojo.dto.SynonymFeedbackDto;
import com.sentum.evidencecomprehensive.pojo.vo.LiteratureGuideVo;
import com.sentum.evidencecomprehensive.pojo.vo.PageVo;

import javax.servlet.http.HttpServletRequest;

/**
 * 检索页面相关逻辑
 * @author zgm
 */
public interface RetrievalService {
    /**
     * 返回文献的全部分类
     * @return 文献的全部分类
     */
    JSONArray typeList();

    /**
     * 根据是否需要翻译检索当前词的中英文同义词
     * @param word 检索词
     * @param range 1-药品；2-疾病；3-参比药物；4-结局指标
     * @param isTranslate 是否需要翻译 1翻译 2不翻译
     * @return 中英文同义词
     */
    JSONObject synonym(String word, Integer range, Integer isTranslate);

    /**
     * 同义词反馈逻辑
     * @param synonymFeedbackDto 请求类
     * @param userId 用户id
     * @return 成功true
     */
    Boolean synonymFeedback(SynonymFeedbackDto synonymFeedbackDto, Long userId);

    /**
     * 查询药品名称相关信息（剂型、药品名称、同义词）
     * @param drug 用户输入药品名称
     * @return 输入词相关信息
     */
    JSONObject drugInfo(String drug);

    /**
     * 根据药品名称检索疾病列表
     * @param drugDto drugs 药品名称及关系列表；isTranslate 是否需要翻译 1翻译 2不翻译；pageSize 每页大小；pageNum 当前页；search 用户输入框输入条件
     * @return 根据药品名称检索的疾病列表
     */
    PageVo<String> disease(DrugDto drugDto);

    /**
     * icd10疾病数据展示
     * @param drugDto drugs 药品名称及关系列表；isTranslate 是否需要翻译 1翻译 2不翻译；pageSize 每页大小；pageNum 当前页；search 用户输入框输入条件
     * @return icd10疾病数据展示
     */
    PageVo<String> icd10(DrugDto drugDto);

    /**
     * 参比药物
     * @param drugDto drugs 药品名称及关系列表；isTranslate 是否需要翻译 1翻译 2不翻译；pageSize 每页大小；pageNum 当前页；search 用户输入框输入条件
     * @return 参比药物列表
     */
    PageVo<String> referenceDrug(DrugDto drugDto);

    /**
     * 结局指标
     * @param outcomeDto diseases 疾病名称及关系列表；isTranslate 是否需要翻译 1翻译 2不翻译；pageSize 每页大小；pageNum 当前页；search 用户输入框输入条件
     * @return 参比药物列表
     */
    PageVo<String> outcome(OutcomeDto outcomeDto);

    /**
     * 存储用户的检索条件
     * @param conditionDto 用户的检索条件
     * @param userId 用户id
     * @return 返回检索条件的id
     */
    JSONObject saveCondition(ConditionDto conditionDto, Long userId, HttpServletRequest request);

    /**
     * 根据检索id回显检索信息
     * @param id 检索id
     * @return 检索信息
     */
    Condition echo(String id);

    String innerSynonym(String str);

    void confirmLGYear(LGYearDto lgYearDto);

    JSONObject acquireStatus(String id, long userId);

    JSONObject acquireLiteratureGuide(String id, long userId);

    void editLiteratureGuide(LiteratureGuideVo literatureGuideVo, long userId);

    String searchMode(String condition, String originalWord, String range, String word);

    JSONObject search(String id, long userId);

    JSONObject personal(String token, long userId);
}
