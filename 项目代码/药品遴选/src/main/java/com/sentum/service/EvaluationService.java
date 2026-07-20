package com.sentum.service;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.lowagie.text.DocumentException;
import com.sentum.pojo.dto.*;
import com.sentum.pojo.vo.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Date;
import java.util.List;
import java.util.Map;

public interface EvaluationService {

    /**
     * 根据用户输入词获得联想词
     * @param word 用户输入词
     * @return 由短到长的5个联想词
     */
    List<String> getAssociationalWord(String word);

    JSONArray getCategory(String type);

    /**
     * 查询当前词的同义词及其翻译
     * @param word 用户输入词
     * @param userId 用户id
     * @return 同义词的集合
     */
    ConditionVo getSynonym(String word, Long userId);

    /**
     * 展示用户检索的历史记录
     * @param userId 用户id
     * @return 历史列表
     */
    JSONArray history(Long userId);

    /**
     * 将当前id的历史记录进行置顶操作/取消置顶
     * @param historyId 历史记录的id
     * @param status 置顶1，取消置顶2
     * @return 置顶成功true
     */
    Integer top(String historyId, Integer status);

    /**
     * 删除当前id的历史记录
     * @param historyId 历史记录id
     * @return 删除成功返回true
     */
    Boolean deleteHistory(String historyId,String isAll,Long userId);

    /**
     * 通过用户操作的条件进行疾病信息的检索
     * @param conditionVo 检索条件
     * @return 疾病信息的列表
     */
    PageVo<Map<String, String>> disease(ConditionVo conditionVo);

    /**
     * 通过用户操作的条件进行药品适应症信息的检索
     * @param conditionVo 检索条件
     * @return 药品适应症信息的列表
     */
    PageVo<DrugAndIndicationVo> drugAndIndication(ConditionVo conditionVo);

    /**
     * 判断用户操作之后是否需要跳转到参比药物页面，true跳转，false不用跳转
     * @param drugAndDiseaseDto 用户勾选的检索条件
     * @return 是否请求参比药物的状态、不请求参比药物时请求分析列表的数据
     */
    JSONObject judge(DrugAndDiseaseDto drugAndDiseaseDto);

    /**
     * 参比药物返回接口
     * @param referenceDrugDto 参比药物检索参数
     * @return 药品与价格列表
     */
    PageVo<DrugAndPriceVo> drugAndPrice(ReferenceDrugDto referenceDrugDto);
    PageVo<DrugAndPriceVo> drugAndPriceAll(ReferenceDrugAllDto referenceDrugDto);

    /**
     * 保存用户输入的药品价格数据
     * @param saveDrugPriceDto 保存用户输入的药品价格的dto类
     * @return 同类药品的唯一id
     */
    String saveDrugPrice(SaveDrugPriceDto saveDrugPriceDto);

    /**
     * 苏大一线上看板显示
     * @param id 当前药品与疾病的id
     * @return 苏大一线上看板的数据
     */
    JSONObject suOnline(String id);

    /**
     * 指南线上看板显示
     * @param id 当前药品与疾病的id
     * @return 指南线上看板显示
     */
    JSONObject guideOnline(String id);

    /**
     * 苏大一-----分析结果的检索
     * @param drugName 药品名称
     * @param disease 疾病名称
     * @param specifications
     * @param isCustom
     * @param userId
     * @return 当前药品与疾病的分析结果及分析过程
     */
    JSONObject suOnAnalysis(String drugName, String disease, String id, String priceId, String specifications, String isCustom, long userId, String drugId, String searchId);

    /**
     * 指南-----分析结果的检索
     * @param drugName 药品名称
     * @param disease 疾病名称
     * @param userId
     * @return 当前药品与疾病的分析结果及分析过程
     */
    JSONObject guideOnAnalysis(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom,String drugId,String searchId);

    /**
     * 苏大一-----分析结果的检索App
     * @param drugName 药品名称
     * @param disease 疾病名称
     * @param specifications
     * @param isCustom
     * @param userId
     * @return 当前药品与疾病的分析结果及分析过程
     */
    JSONObject suOnAnalysisApp(String drugName, String disease, String id, String priceId, String specifications, String isCustom, long userId);

    /**
     * 指南-----分析结果的检索App
     * @param drugName 药品名称
     * @param disease 疾病名称
     * @param specifications 规格
     * @param isCustom 是否是自定义疾病
     * @return 当前药品与疾病的分析结果及分析过程
     */
    JSONObject guideOnAnalysisApp(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom);


    void guideAppAsynchronous(String drugName, String disease, String specifications, String id, String priceId,
                              long userId, String isCustom, HttpServletRequest request,String token,Boolean x);
    void guideAppAsynchronousTr(String drugName, String disease, String id, String priceId,
                                long userId,  String drugId, String searchId,String token,Boolean x);




    /**
     * 指南版本看板word下载
     * @param id 当前药品与疾病的id
     * @param response response
     */
    void guideDownloadWord(String id, HttpServletResponse response) throws IOException, DocumentException;
    void guideDownloadPdf(String id, HttpServletResponse response) throws IOException, DocumentException;
    void guideDownloadV2Pdf(String id, HttpServletResponse response) throws IOException, DocumentException;
    void guideDownloadWordPc(String id, HttpServletResponse response) throws IOException, DocumentException;

    /**
     * 指南版本看板word下载
     * @param ids 当前药品与疾病的id
     * @param response response
     */
    void guideDownloadWords(String ids, HttpServletResponse response) throws IOException, DocumentException;

    /**
     * 苏大一版本看板word下载
     * @param id 当前药品与疾病的id
     * @param response response
     */
    void suDownloadWord(String id, HttpServletResponse response) throws IOException, DocumentException;

    /**
     * 苏大一版本看板excel下载
     * @param id 当前药品与疾病的id
     * @param response response
     */
    void suDownloadExcel(String id, HttpServletResponse response) throws IOException;

    /**
     * 将说明书的url请求到文件然后转化为base64
     * @param url 说明说的存储路径
     * @return 转化为base64格式的文件
     */
    JSONObject urlToBase64(String url);

    //===================================数据处理逻辑==========================================
    /**
     * 将药品分类与药品名称表按照要求格式写入mongo
     */
    void insertGradeAndDrugsTable();

    /**
     * 将药品适应症数据写入es中（弃用）
     */
    void insertToIndex();

    /**
     * 将药品价格信息写入mongo（弃用）
     */
    void insertDrugPrice();

    /**
     * 更改算法提供数据格式以满足现有代码逻辑（弃用）
     */
    void changeDrugIndicationDataForm();

    /**
     * 处理新版本表 mongo es
     */
    void handleDrugInfo();

    /**
     * easyexcel导入药品表
     */
    void importDrugInfo();

    /**
     * 计算app 端 pc的各个模块得分 
     */
    void calculateTotalScore(JSONObject result, JSONObject jsonObject, String drugName, String disease);

    /**
     * 计算app 端 苏大一的各个模块得分 
     */
    void calculateTotalScoreSdy(JSONObject result, JSONObject jsonObject, String drugName, String disease);

    /**
     * 保存获取同义词列表 中的 勾选与反勾选的同义词
     */
    void saveSynonym(List<SynonymVo> synonym, long userId);


     void generateLianhuaQingwenReport(HttpServletResponse response,String id) throws IOException, DocumentException;
     void generateLianhuaQingwenReports(HttpServletResponse response,String id) throws IOException, DocumentException;

    /**
     * 查询合理用药
     */
    JSONObject getHeliYongYao(String drugs);


    /**
     * 用户自主添加说明书
     *
     * @return
     */
    Object drugAdd(DrugAddDto drugAddDto,Long userId);

    DrugAddVo drugData(String searchId,String drugId);

    void getInstructionsDeduplicated(Long hasData);

    void insUpdate(String id);

    List<Object> getlines(String disease, String searchId, String drugIds);

    Object drugDataInfo(String disease, String searchId, String drugId);

    DrugDataSdyVo drugDataSdy(String disease,String searchId, String drugId);

    List<Object> getlinesSdy(String disease, String searchId, String drugIds);

    Object getOther(String disease, String searchId, String drugIds);

    List<DrugDisData> getDataTal(String disease, String searchId, String drugIds);

     List<DrugDisSdy> drugSdyTal(String disease, String searchId, String drugIds);

    List<DrugDisData> getDataTalPuls(String disease, String searchId, String drugIds);

    List<DrugDisSdy> drugSdyTalPlus(String disease, String searchId, String drugIds);

    void guideAppAsynchronousx(String idx, long userId, HttpServletRequest request, String finalToken, String ids, Date date,boolean istr);

    void generateReport(HttpServletResponse response, String userId) throws IOException, DocumentException;
}
