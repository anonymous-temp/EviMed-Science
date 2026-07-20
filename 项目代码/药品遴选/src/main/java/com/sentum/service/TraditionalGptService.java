package com.sentum.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.dto.*;
import com.sentum.pojo.vo.BulletinBoardVo;

import java.util.List;
import java.util.Map;
import java.util.concurrent.Future;

public interface TraditionalGptService {


    /**
     * 不良反应
     * @param drugInfoNew
     * @param futureResult
     */
     void setAdvGpt(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult);


    /**
     * 有效性
     * @param drugInfoNew
     * @param futureResult
     */
     int setEffective(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult, int step, String id, List<String> stringBuilder, Map<String,String> map, BulletinBoardVo bulletinBoardVo, TraditionalInfoDto traditionalInfoDto);



     int setEffective1(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult,int step,String id,List<String> stringBuilder,Map<String,String> map,BulletinBoardVo bulletinBoardVo,TraditionalInfoDto traditionalInfoDto);
     int setEffective1App(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult,int step,String id,List<String> stringBuilder,Map<String,String> map,BulletinBoardVo bulletinBoardVo,TraditionalInfoDto traditionalInfoDto);
    /**
     * 成本
     * @param drugInfoNew
     * @param futureResult
     */
     int setMoneyRelevant(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult,int step,String id,List<String> stringBuilder,Map<String,String> map,BulletinBoardVo bulletinBoardVo,TraditionalInfoDto traditionalInfoDto);


    /**
     * 性质
     * @param drugInfoNew
     * @param futureResult
     */
     int setDrugCharacteristic(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult,int step,String id,List<String> stringBuilder,Map<String,String> map,BulletinBoardVo bulletinBoardVo,TraditionalInfoDto traditionalInfoDto);


    /**
     * 适用性
     */
    int setApplicability(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult, int step, String id, List<String> stringBuilder,Map<String,String> map,BulletinBoardVo bulletinBoardVo,TraditionalInfoDto traditionalInfoDto);

    /**
     * 政策准入
     */
    int setPolicyAdmission(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult,int step,String id,List<String> stringBuilder,Map<String,String> map,BulletinBoardVo bulletinBoardVo,TraditionalInfoDto traditionalInfoDto);


     TrInheritanceEvaluationDto getTrInheritanceEvaluationDto(DrugInfoNew drugInfoNew);

     TrClinicalEvaluationDto getTrClinicalEvaluationDto(DrugInfoNew drugInfoNew);

     TrSafetyEvaluationDto getTrSafetyEvaluationDto(DrugInfoNew drugInfoNew);

     TrTechnologyEvaluationDto getTrTechnologyEvaluationDto(DrugInfoNew drugInfoNew);

     TrMarketEvaluationDto getTrMarketEvaluationDto(DrugInfoNew drugInfoNew);





}
