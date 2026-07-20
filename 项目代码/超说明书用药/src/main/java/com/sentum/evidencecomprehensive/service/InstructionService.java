package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.vo.InstructionVo;
import com.sentum.evidencecomprehensive.pojo.vo.PageVo;

import java.util.List;

/**
 * 说明书页面相关逻辑
 * @author zgm
 */
public interface InstructionService {
    /**
     * 根据用户选择的药品名称获取左边栏说明书可查询类型
     * @param id 检索条件id
     * @return 类型列表
     */
    List<String> typeList(String id);

    /**
     * 查询说明书列表
     * @param id 检索条件id
     * @param type 选中的说明书的分类
     * @param pageSize 每页大小
     * @param pageNum 当前页
     * @param search 适应症筛选框输入内容
     * @param userId 用户id
     * @return 说明书列表
     */
    PageVo<InstructionVo> list(String id, String type, Integer pageSize, Integer pageNum, String search, Long userId);

    /**
     * 说明书收藏/取消收藏
     * @param id 检索条件id
     * @param instructionId 说明书id
     * @param userId 用户id
     * @param operate 操作的命令，1-收藏入；2-取消收藏
     * @return 成功true
     */
    Boolean operate(String id, String instructionId, Long userId, Integer operate);

    /**
     * 查询说明书的禁忌、特殊人群用药情况、不良反应
     * @param id 检索id
     * @param hasReferenceDrug 判断是福哦需要参比药物数据 true需要
     * @return 说明书的相关信息
     */
    JSONArray searchFullInstruction(String id, Boolean hasReferenceDrug);

    List<JSONObject> initInstructions(String id);

    PageVo<InstructionVo> navigationList(String id, String oneLevelTerm, String twoLevelTerm, String threeLevelTerm, Integer pageSize, Integer pageNum, String search);

    JSONObject instructionHtml(String source, String pdfName);
}
