package com.sentum.drugsafe.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.dto.FdaQueryCondition;
import com.sentum.drugsafe.pojo.FileInfoUploadDto;
import com.sentum.drugsafe.pojo.SearchCondition;
import com.sentum.drugsafe.pojo.SummaryContentVO;
import com.sentum.drugsafe.pojo.ReleaseVO;
import com.sentum.drugsafe.utils.Page;

import java.util.List;

/**
 * 新版本药物安全性分析
 * @author  wangxm
 * @since 20230928
 */
public interface DrugAnalyzerService {


     String translate(String word);

    /**
     * 执行搜索
     * @param query 查询条件
     * @return 根据条件返回不同结果
     */
    JSONObject search(String query,String isApp);

    /**
     * 执行搜索
     * @param searchCondition 查询条件
     * @return 根据条件返回不同结果
     */
    JSONObject searchPlus(SearchCondition searchCondition);

    /**
     * 通过不良反应查询药品
     * @return 根据条件返回不同结果
     */
   JSONObject getDrugByPt(String id, String drugName,Integer sort, Integer pageNum, Integer pageSize);


   JSONObject getDrugByPtJd(String id, String drugName,Integer sort, Integer pageNum, Integer pageSize);

    /**
     * 通过分词查询概览页面条件面板drugName
     * @return 根据条件返回不同结果
     */
   JSONObject getFdaSearhConditon(String id,String drugName);


   JSONObject getFdaSearhConditonJd(String id,String drugName);

    /**
     * 保存用户自定义同义词词
     * @param jsonObject
     * @return
     */
   void saveUserSynonym(JSONObject jsonObject);

    /**
     * 查询同义词
     * @param id 查询id
     * @return
     */
   JSONObject getSynonymById(String id);

    /**
     * 获取分析报告
     * @param conditionId
     * @return
     */
   JSONObject getReport(String conditionId,String drugName);




   JSONObject getReportJd(String conditionId,String drugName);

    /***
     *
     * @param fdaQueryCondition
     * @return
     */
   JSONObject getFda(FdaQueryCondition fdaQueryCondition);



   JSONObject getFdaJd(FdaQueryCondition fdaQueryCondition);

    /**
     *
     * @param id
     * @return
     */
   JSONObject summary(String id);

    /**
     * 临床试验
     * @param id
     * @return
     */
   List<JSONObject> getCilinical(String id);

    /**
     * 保存给概述
     */
   void saveSummary(SummaryContentVO summaryContentVO);

    /**
     * 上传
     */
   Boolean upload(FileInfoUploadDto fileInfoUploadDto);

    /**
     * 发布列表
     */
   Page<ReleaseVO> listPub(String words, Integer pageNum, Integer pageSize);

    /**
     * 收藏
     * @param status  true 收藏 false 取消收藏
     */
   void  collectPub(String id,boolean status);

   /**
    * adrs
    */
   void adrs(String startDate);

   void instructions();

}