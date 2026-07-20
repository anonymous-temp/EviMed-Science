package com.sentum.evidencecomprehensive.pojo.dto.entity;

import com.alibaba.fastjson.JSONArray;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.extension.handlers.FastjsonTypeHandler;
import io.swagger.annotations.ApiModel;
import lombok.*;

import java.io.Serializable;
import java.util.Date;

@Data
@Builder
@EqualsAndHashCode(callSuper = false)
@ApiModel(value = "PdfEdit对象", description = "pdf质量编辑实体类")
@TableName("pdf_edit")
@NoArgsConstructor
@AllArgsConstructor
public class PdfEdit implements Serializable {

    private static final long serialVersionUID = 1L;


    /**
     * id
     */
    @TableId(value = "id", type = IdType.AUTO)
    private String id;

    /**
     * 文献 id
     */
    private String paperId;

    /**
     * 文献 类型
     */
    private String paperType;

    /**
     *  课题 id
     */
    private String questionId;

    /**
     *  标准 id  对应modelId
     */
    private String standardId;

    /**
     *  标准 id 对应的 标题 title
     */
    private String title;

    /**
     *  标题悬停提示，只有 meta 有
     */
    private String titleTips;

    /**
     *  评价结果  对应 predict
     */
    private String standardValue;

    /**
     * 解析实体内容
     */
    @TableField(value = "body", typeHandler = FastjsonTypeHandler.class)
    private JSONArray body;

    /**
     *  理由
     */
    private String reason;

    /**
     *  文件存储所在文件夹名称
     */
    private String path;

    /**
     *  状态 0没有解析出内容 1解析出内容
     */
    private int status;

    /**
     *  创建时间
     */
    private Date createTime;
}
