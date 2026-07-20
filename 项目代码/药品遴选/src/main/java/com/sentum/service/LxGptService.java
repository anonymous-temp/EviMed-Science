package com.sentum.service;

import com.alibaba.fastjson.JSONObject;
import com.github.rholder.retry.RetryException;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.dto.DrugAddDto;
import com.sentum.pojo.vo.DataResult;
import com.sentum.pojo.vo.GuideVO;
import com.sentum.pojo.vo.Literature;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;

public interface LxGptService {
     /**
      * 苏大一看板
      */
     JSONObject sdyPanel(String drugName, String disease, String id, String priceId, String specifications, String isCustom, long userId, String drugId, String searchId);

     /**
      * 苏大一app看板改版
      */
     JSONObject sdyPanelApp(String drugInfo, String disease, String id, String priceId, String specifications, String isCustom, long userId);
          
     /**
      * 指南看板
      */
     JSONObject guidePanel(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom,String drugId,String searchId);

     /**
      * 苏大一看板App
      */
     JSONObject sdyPanelApp_bak(String drugName, String disease,String id,String priceId);

     /**
      * 指南检索 APP  存留的上一版本
      */
     JSONObject guidePanelApp_bak(String drugName, String disease,String id,String priceId);

     /**
      * 指南看板App
      */
     JSONObject guidePanelApp(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom);

     /**
      * 从redis中获取打字结果
      */
     DataResult getProcess(String id, int step);

     /**
      * 改版中
      */
     JSONObject guidePanel_bbbbbbak(String drugInfo, String disease, String specifications, String id, String priceId, long userId, String isCustom);


     String getTransDeepl(String s);

    void GetSynonyms(String drugName, List<String> drugs, String disease, List<String> diseases);

    List<Literature> queryLiterature(String drugName, List<String> drugs, String disease, List<String> diseases);

     List<GuideVO> queryGuideByDrugAndDisease(List<String> drugs, String drugName, List<String> diseases, String disease);


      String getGpt(String gpt,String model,String score);
      String getGptx(String gpt,String model,JSONObject jsonObject);

     JSONObject executeGptPlus(String query, String name, JSONObject jsonObject1,String model,String score);


      List<GuideVO> searchGuideTop5(String drug, String disease);



    public void useThreadPoolExecutePrompt(String drugName, String disease, DrugInfoNew drugInfo,
                                           String enterpriseName, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap,
                                           Map<GuideVO, JSONObject> guideEffectiveMap, Map<GuideVO, JSONObject> guideOldEffectiveMap,
                                           Map<Literature, JSONObject> literatureMap, DrugAddDto drugAdd, List<String> drugs, List<String> diseases);

      //以下为所有的ai接口
       JSONObject pharmacology(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException;

     JSONObject pharmacokinetics(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException ;

     JSONObject usageAndDosage(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException;

    JSONObject storage(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException;

    JSONObject indate(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException;

    public List<GuideVO> queryGuideByDrugAndDisease1(List<String> drugs, String drugName, List<String> diseases, String disease);

    }
