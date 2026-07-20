package com.sentum.evidencecomprehensive.domain.mongo.upload;

import com.alibaba.fastjson.JSONObject;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 用户上传文献pdf转图片 & pdf进行算法定位实体类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_pdf_analysis")
public class PdfAnalysis {

    /**
     * id
     */
    @Id
    private String id;

    /**
     * 文献id
     */
    private String paperId;
    
    private String paperType;

    /**
     * 用户 id
     */
    private Long userId;

    /**
     * pdf 是否全部转为图片 true是 false否
     */
    private Boolean success;

    /**
     * pdf 上传到服务器中的名称 也是图片当前目录名称
     */
    private String path;

    /**
     * 图片存放路径 pdf 转为图片的当前目录
     */
    private String filePath;

    /**
     * 算法解析成功之后 有四角坐标的图片的当前目录
     */
    private String algFilePath;

    /**
     * 存储到服务器中的公网可访问的绝对路径 不包含文件名称
     */
    private String ipFilePath;

    /**
     * 存储到服务器中的公网可访问的绝对路径 不包含文件名称
     */
    private String ipAlgFilePath;

    /**
     * 存储到服务器中pdf的名称
     */
    private String pdfName;

    /**
     * pdf转换成图片的总数量
     */
    private Integer imagesCount;

    /**
     * 图片类型
     */
    private String type;

    /**
     * 第一张图片存放地址地址
     */
    private String onePicUrl;
    
    
    
    
    
    

    // ##################### 以下是算法定位 pdf 的位置##########################
    /**
     * 算法接口是否调用成功
     */
    private Boolean algSuccess;

    /**
     * 算法接口数据
     */
    private JSONObject data;

    /**
     * 算法解析失败原因 自定义
     */
    private String failureReason;


    
    

    // ##################### 判断当前文献对应的质量评价的状态 ##########################
    /**
     * 1 pdf正在被替换 2 pdf转图片过程失败 3 pdf正在解析 4 pdf 解析失败
     */
    private Integer status;

    /**
     * 是否被替换
     */
    private Boolean replace;

    /**
     * 课题id
     * 区分同一篇文献不同课题的解析
     */
    private String questionId;
}
